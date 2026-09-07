// popup.js
// Handles the UI states and communication with the background script

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const states = {
    scanning: document.getElementById('state-scanning'),
    empty: document.getElementById('state-empty'),
    videos: document.getElementById('state-videos'),
    downloading: document.getElementById('state-downloading'),
    complete: document.getElementById('state-complete')
  };
  
  const videoList = document.getElementById('videoList');
  const rescanBtn = document.getElementById('rescanBtn');
  
  // Start scanning
  switchState('scanning');
  
  // Ask background for detected media in current tab
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if (tabs.length === 0) return;
    const currentTab = tabs[0];
    
    setTimeout(() => {
      chrome.runtime.sendMessage(
        { type: 'GET_DETECTED_MEDIA', tabId: currentTab.id },
        (response) => {
          if (chrome.runtime.lastError || !response || !response.media || response.media.length === 0) {
            switchState('empty');
          } else {
            renderVideos(response.media);
            switchState('videos');
          }
        }
      );
    }, 600);
  });
  
  rescanBtn.addEventListener('click', () => {
    // Re-trigger scan
    switchState('scanning');
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
      if (tabs.length === 0) return;
      setTimeout(() => {
        chrome.runtime.sendMessage(
          { type: 'GET_DETECTED_MEDIA', tabId: tabs[0].id },
          (response) => {
            if (!response || !response.media || response.media.length === 0) {
              switchState('empty');
            } else {
              renderVideos(response.media);
              switchState('videos');
            }
          }
        );
      }, 600);
    });
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
      const card = clone.querySelector('.video-card');
      const titleEl = clone.querySelector('.video-title');
      const subtitleEl = clone.querySelector('.video-subtitle');
      const methodBadge = clone.querySelector('.method-badge');
      const qualitySelect = clone.querySelector('.quality-select');
      const downloadBtn = clone.querySelector('.download-btn');
      const sizeLabel = clone.querySelector('.est-size');
      
      // Set title
      titleEl.textContent = media.title || `Video ${idx + 1}`;
      
      // Set subtitle (show trimmed URL for context)
      // Set subtitle (show context about the source)
      if (media.type === 'mse-stream' || (media.type === 'hls' && media.duration)) {
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
          subtitleEl.textContent = media.type === 'hls' ? 'HLS Stream' : 'Direct Video';
        }
      }
      
      // Set badge
      if (media.type === 'mse-stream') {
        methodBadge.textContent = '🎬 Stream';
        methodBadge.classList.add('hls');
      } else if (media.type === 'hls') {
        methodBadge.textContent = '⚡ HLS';
        methodBadge.classList.add('hls');
      } else {
        methodBadge.textContent = '📁 Direct';
      }
      
      // For HLS: fetch qualities from the manifest
      // ─── MSE STREAM: Show current playing quality ──────────────
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
        
      // ─── HLS: Fetch qualities from manifest ────────────────────
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
      // ─── DIRECT: Single quality ─────────────────────────────────
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
      
      // Unique radio group name per card
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
    
    // ─── DIRECT FILE DOWNLOAD ───
    if (media.type === 'direct' || downloadUrl.includes('.mp4') || downloadUrl.includes('.webm')) {
      switchState('downloading');
      document.getElementById('dl-title').textContent = media.title || 'video.mp4';
      document.getElementById('tier-badge').textContent = '📁 Direct Download';
      
      // We don't have progress events for native downloads yet, so we just show an indeterminate bar
      document.getElementById('dl-percent').textContent = 'Native Download';
      document.getElementById('dl-progress-bar').style.width = '100%';
      document.getElementById('dl-progress-bar').style.animation = 'pulse 2s infinite';
      document.getElementById('dl-size').textContent = `Size: ${estSize}`;
      document.getElementById('dl-speed').textContent = 'Check Chrome Downloads';
      document.getElementById('dl-eta').textContent = '';
      
      chrome.runtime.sendMessage({
        type: 'START_DIRECT_DOWNLOAD',
        url: downloadUrl,
        filename: filename
      });
      
      setTimeout(() => {
        switchState('complete');
        document.getElementById('complete-filename').textContent = filename;
        document.getElementById('complete-size').textContent = `Download started in browser`;
      }, 3000);
      
      return;
    }
    
    // ─── MSE STREAM ALERT ───
    if (media.type === 'mse-stream') {
      alert("MSE Streams (blob: URLs) cannot be downloaded directly. Please use the HLS or Direct Video card if one was detected for this video.");
      return;
    }
    
    // ─── HLS DOWNLOAD (Future implementation) ───
    switchState('downloading');
    document.getElementById('dl-title').textContent = media.title || 'video.mp4';
    document.getElementById('tier-badge').textContent = '⚡ Tier 1: HLS Download';
    
    chrome.runtime.sendMessage({
      type: 'START_HLS_DOWNLOAD',
      url: downloadUrl,
      filename: filename
    });
    
    // Listen for real progress updates from background/offscreen
    const progressListener = (message) => {
      if (message.type === 'DOWNLOAD_PROGRESS') {
        document.getElementById('dl-percent').textContent = message.progress + '%';
        document.getElementById('dl-progress-bar').style.width = message.progress + '%';
        document.getElementById('dl-size').textContent = `Segments: ${message.segmentsDownloaded}/${message.totalSegments}`;
        document.getElementById('dl-speed').textContent = message.speed || '';
        if (message.eta) document.getElementById('dl-eta').textContent = `ETA: ${message.eta}`;
      } else if (message.type === 'DOWNLOAD_COMPLETE') {
        chrome.runtime.onMessage.removeListener(progressListener);
        switchState('complete');
        document.getElementById('complete-filename').textContent = filename;
        document.getElementById('complete-size').textContent = `Transmuxing complete. Saved!`;
      } else if (message.type === 'DOWNLOAD_ERROR') {
        chrome.runtime.onMessage.removeListener(progressListener);
        alert(`Download failed: ${message.error}`);
        switchState('videos');
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);
    
    document.getElementById('cancelDlBtn').onclick = () => {
      chrome.runtime.onMessage.removeListener(progressListener);
      chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD' });
      switchState('videos');
    };
  }
  
  document.getElementById('closeBtn').addEventListener('click', () => {
    window.close();
  });
  
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
