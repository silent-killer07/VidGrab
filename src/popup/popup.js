// popup.js
// Handles the UI states and communication with the background script

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const states = {
    scanning: document.getElementById('state-scanning'),
    empty: document.getElementById('state-empty'),
    videos: document.getElementById('state-videos')
  };
  
  const videoList = document.getElementById('videoList');
  const downloadsList = document.getElementById('downloadsList');
  const downloadsEmpty = document.getElementById('downloads-empty');
  const rescanBtn = document.getElementById('rescanBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  
  // Tabs
  const tabs = {
    scanner: { btn: document.getElementById('tab-scanner'), view: document.getElementById('view-scanner') },
    downloads: { btn: document.getElementById('tab-downloads'), view: document.getElementById('view-downloads') }
  };
  const dlBadge = document.getElementById('dl-badge');
  
  let currentTab = 'scanner';
  let pollInterval = null;

  function switchTab(tabId) {
    currentTab = tabId;
    Object.values(tabs).forEach(t => {
      t.btn.classList.remove('active');
      t.view.classList.remove('active');
      t.view.classList.add('hidden');
    });
    tabs[tabId].btn.classList.add('active');
    tabs[tabId].view.classList.remove('hidden');
    tabs[tabId].view.classList.add('active');
    
    if (tabId === 'downloads') {
      startPollingDownloads();
    } else {
      stopPollingDownloads();
    }
  }

  tabs.scanner.btn.addEventListener('click', () => switchTab('scanner'));
  tabs.downloads.btn.addEventListener('click', () => switchTab('downloads'));

  // Start scanning
  switchState('scanning');
  
  function loadMedia() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabsList) {
      if (tabsList.length === 0) return;
      const currentTabId = tabsList[0].id;
      
      chrome.runtime.sendMessage(
        { type: 'GET_DETECTED_MEDIA', tabId: currentTabId },
        (response) => {
          if (chrome.runtime.lastError || !response || !response.media || response.media.length === 0) {
            switchState('empty');
          } else {
            renderVideos(response.media);
            switchState('videos');
          }
        }
      );
    });
  }
  
  setTimeout(() => {
    loadMedia();
    fetchDownloads(true); // initial fetch to update badge
  }, 600);
  
  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    switchState('scanning');
    chrome.tabs.query({active: true, currentWindow: true}, function(tabsList) {
      if (tabsList.length === 0) return;
      
      chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: tabsList[0].id }, () => {
        if (chrome.runtime.lastError) console.log(chrome.runtime.lastError.message);
      });
      chrome.tabs.sendMessage(tabsList[0].id, { type: 'FORCE_RESCAN' }, () => {
        if (chrome.runtime.lastError) console.log(chrome.runtime.lastError.message);
      });
      
      setTimeout(() => {
        loadMedia();
        refreshBtn.classList.remove('spinning');
      }, 800);
    });
  });
  
  rescanBtn.addEventListener('click', () => {
    switchState('scanning');
    loadMedia();
  });
  
  function switchState(stateName) {
    Object.values(states).forEach(el => el.classList.add('hidden'));
    states[stateName].classList.remove('hidden');
  }
  
  function renderVideos(mediaList) {
    videoList.innerHTML = '';
    const template = document.getElementById('video-card-template');
    
    mediaList.forEach((media, idx) => {
      const clone = template.content.cloneNode(true);
      const titleEl = clone.querySelector('.video-title');
      const subtitleEl = clone.querySelector('.video-subtitle');
      const methodBadge = clone.querySelector('.method-badge');
      const qualitySelect = clone.querySelector('.quality-select');
      const downloadBtn = clone.querySelector('.download-btn');
      const sizeLabel = clone.querySelector('.est-size');
      
      titleEl.textContent = media.title || `Video ${idx + 1}`;
      
      if (media.type === 'mse-stream' || ((media.type === 'hls' || media.type === 'dash') && media.duration)) {
        const durationStr = media.duration ? formatDuration(media.duration) : '';
        const resStr = media.resolution || '';
        subtitleEl.textContent = [resStr, durationStr].filter(Boolean).join(' • ') || 'Streaming Video';
      } else {
        try {
          const urlObj = new URL(media.url);
          const pathParts = urlObj.pathname.split('/').filter(Boolean);
          const shortPath = pathParts.slice(-2).join('/');
          subtitleEl.textContent = `${urlObj.hostname}/${shortPath}`;
        } catch(e) {
          subtitleEl.textContent = media.type === 'hls' ? 'HLS Stream' : (media.type === 'dash' ? 'DASH Stream' : 'Direct Video');
        }
      }
      
      if (media.type === 'mse-stream') {
        methodBadge.textContent = '🎬 Stream';
        methodBadge.classList.add('hls');
      } else if (media.type === 'hls') {
        methodBadge.textContent = '⚡ HLS';
        methodBadge.classList.add('hls');
      } else if (media.type === 'dash') {
        methodBadge.textContent = '⚡ DASH';
        methodBadge.classList.add('hls');
      } else {
        methodBadge.textContent = '📁 Direct';
      }
      
      if (media.type === 'mse-stream') {
        if (media.extractedQualities && media.extractedQualities.length > 0) {
          media.extractedQualities.forEach((q, i) => {
            const opt = document.createElement('option');
            opt.value = q.id || i;
            opt.textContent = q.isCurrent ? `${q.label} (Current)` : q.label;
            if (q.isCurrent) opt.selected = true;
            qualitySelect.appendChild(opt);
          });
        } else {
          const opt = document.createElement('option');
          opt.value = 'stream-capture';
          const res = media.resolution || 'Original';
          opt.textContent = `${res} (Current Playback)`;
          qualitySelect.appendChild(opt);
        }
        sizeLabel.textContent = media.duration ? `(${formatDuration(media.duration)})` : '';
        
      } else if (media.type === 'hls') {
        qualitySelect.innerHTML = '<option value="loading">Loading qualities...</option>';
        qualitySelect.disabled = true;
        
        chrome.runtime.sendMessage(
          { type: 'PARSE_HLS_MANIFEST', url: media.url },
          (result) => {
            qualitySelect.disabled = false;
            qualitySelect.innerHTML = '';
            
            if (result && result.qualities && result.qualities.length > 0) {
              result.qualities.forEach((q, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.dataset.url = q.url;
                opt.dataset.bandwidth = q.bandwidth;
                opt.dataset.size = q.estimatedSize || '';
                const sizeText = q.estimatedSize ? ` (~${q.estimatedSize})` : '';
                opt.textContent = `${q.label}${sizeText}`;
                qualitySelect.appendChild(opt);
              });
              
              updateDownloadButtonSize(qualitySelect, sizeLabel);
              qualitySelect.addEventListener('change', () => {
                updateDownloadButtonSize(qualitySelect, sizeLabel);
              });
            } else {
              const opt = document.createElement('option');
              opt.value = 'default';
              opt.textContent = 'Original Quality';
              qualitySelect.appendChild(opt);
              sizeLabel.textContent = '';
            }
          }
        );
      } else if (media.type === 'dash') {
        const opt = document.createElement('option');
        opt.value = 'default';
        opt.textContent = 'DASH Playlist (.mpd)';
        qualitySelect.appendChild(opt);
        sizeLabel.textContent = media.duration ? `(${formatDuration(media.duration)})` : '';
        
      } else {
        const opt = document.createElement('option');
        opt.value = 'default';
        opt.textContent = 'Original Quality';
        qualitySelect.appendChild(opt);
        
        sizeLabel.textContent = '';
        fetch(media.url, { method: 'HEAD', mode: 'no-cors' })
          .then(resp => {
            const len = resp.headers.get('content-length');
            if (len) {
              sizeLabel.textContent = `(~${formatBytes(parseInt(len))})`;
            }
          })
          .catch(() => {});
      }
      
      const formatRadios = clone.querySelectorAll('input[name="format"]');
      formatRadios.forEach(radio => {
        radio.name = `format-${idx}`;
      });
      
      downloadBtn.addEventListener('click', () => {
        startDownload(media, qualitySelect);
      });
      
      videoList.appendChild(clone);
    });
  }
  
  function updateDownloadButtonSize(select, sizeLabel) {
    const selected = select.options[select.selectedIndex];
    if (selected && selected.dataset.size) {
      sizeLabel.textContent = `(~${selected.dataset.size})`;
    } else {
      sizeLabel.textContent = '';
    }
  }
  
  function startDownload(media, qualitySelect) {
    const selected = qualitySelect.options[qualitySelect.selectedIndex];
    const downloadUrl = selected?.dataset?.url || media.url;
    const estSize = selected?.dataset?.size || '? MB';
    const filename = (media.title || 'video').replace(/[<>:"/\\|?*]+/g, '_') + '.mp4';
    
    if (media.type === 'direct' || downloadUrl.includes('.mp4') || downloadUrl.includes('.webm')) {
      chrome.runtime.sendMessage({
        type: 'START_DIRECT_DOWNLOAD',
        url: downloadUrl,
        filename: filename
      });
      switchTab('downloads');
      return;
    }
    
    if (media.type === 'mse-stream') {
      alert("MSE Streams (blob: URLs) cannot be downloaded directly. Please use the HLS or Direct Video card if one was detected for this video.");
      return;
    }
    
    if (media.type === 'dash') {
      alert("DASH Streams (.mpd) cannot be downloaded natively by VidGrab yet. Please try another video source if available, or use a third-party tool like yt-dlp.");
      return;
    }
    
    // HLS DOWNLOAD
    chrome.runtime.sendMessage({
      type: 'START_HLS_DOWNLOAD',
      url: downloadUrl,
      filename: filename,
      size: estSize
    });
    
    switchTab('downloads');
  }
  
  // ─── DOWNLOADS POLLING ───
  function startPollingDownloads() {
    fetchDownloads();
    if (!pollInterval) {
      pollInterval = setInterval(fetchDownloads, 1000);
    }
  }
  
  function stopPollingDownloads() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
  
  function fetchDownloads(updateBadgeOnly = false) {
    chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (!response || !response.downloads) return;
      
      const activeCount = response.downloads.filter(d => d.status === 'downloading').length;
      if (activeCount > 0) {
        dlBadge.textContent = activeCount;
        dlBadge.classList.remove('hidden');
      } else {
        dlBadge.classList.add('hidden');
      }
      
      if (!updateBadgeOnly && currentTab === 'downloads') {
        renderDownloads(response.downloads);
      }
    });
  }
  
  function renderDownloads(downloads) {
    if (downloads.length === 0) {
      downloadsList.innerHTML = '';
      downloadsEmpty.classList.remove('hidden');
      return;
    }
    
    downloadsEmpty.classList.add('hidden');
    
    // Sort active downloads to top
    downloads.sort((a, b) => {
      if (a.status === 'downloading' && b.status !== 'downloading') return -1;
      if (a.status !== 'downloading' && b.status === 'downloading') return 1;
      return parseInt(b.id) - parseInt(a.id);
    });
    
    // To avoid flickering, we should selectively update existing elements or just re-render.
    // Given the simplicity, we'll re-render but preserve structure to avoid losing focus/clicks.
    downloadsList.innerHTML = '';
    const template = document.getElementById('download-card-template');
    
    downloads.forEach(dl => {
      const clone = template.content.cloneNode(true);
      clone.querySelector('.video-title').textContent = dl.title;
      
      const barFill = clone.querySelector('.progress-bar-fill');
      const percentEl = clone.querySelector('.dl-percent');
      const sizeEl = clone.querySelector('.dl-size');
      const speedEl = clone.querySelector('.dl-speed');
      const etaEl = clone.querySelector('.dl-eta');
      const cancelBtn = clone.querySelector('.cancel-dl-btn');
      
      barFill.style.width = `${dl.progress}%`;
      percentEl.textContent = `${dl.progress}%`;
      
      if (dl.status === 'downloading') {
        sizeEl.textContent = dl.size;
        speedEl.textContent = dl.speed || '-- MB/s';
        etaEl.textContent = dl.eta ? `ETA: ${dl.eta}` : 'ETA: --';
        
        cancelBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD_BY_ID', id: dl.id });
          fetchDownloads();
        });
      } else if (dl.status === 'complete') {
        barFill.style.background = 'linear-gradient(90deg, #00D2FF 0%, #3A7BD5 100%)';
        sizeEl.textContent = 'Complete';
        speedEl.textContent = '';
        etaEl.textContent = '';
        cancelBtn.style.display = 'none';
      } else if (dl.status === 'error') {
        barFill.style.background = 'var(--error)';
        sizeEl.textContent = 'Error';
        speedEl.textContent = dl.error || 'Failed';
        etaEl.textContent = '';
        cancelBtn.style.display = 'none';
      } else if (dl.status === 'cancelled') {
        barFill.style.background = 'var(--text-secondary)';
        sizeEl.textContent = 'Cancelled';
        speedEl.textContent = '';
        etaEl.textContent = '';
        cancelBtn.style.display = 'none';
      }
      
      downloadsList.appendChild(clone);
    });
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
  
  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '';
    seconds = Math.round(seconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
});
