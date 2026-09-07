// service-worker.js
// Central coordinator for VidGrab

const STATE = {
  // Store detected media per tab
  // tabId -> { detectedMedia: [] }
  tabs: new Map()
};

// ─── Smart URL Filtering ──────────────────────────────────────────
// Only track MASTER playlists and FULL video files.
// NEVER track individual streaming segments (.ts, .m4s, init.mp4, 1.mp4, etc.)
function isTrackableMediaUrl(url) {
  const lower = url.toLowerCase();
  
  // YES: Master HLS playlists
  if (lower.includes('.m3u8')) return true;
  
  // YES: DASH manifests
  if (lower.includes('.mpd')) return true;
  
  // MAYBE: .mp4 / .webm files — need extra checks to distinguish
  // full videos from tiny DASH/MSE segments
  if (lower.includes('.mp4') || lower.includes('.webm') || lower.includes('.m4v')) {
    
    // ── EXCLUDE: Streaming segment patterns ──
    // DASH init segments (e.g. /240/init.mp4, /init.mp4)
    if (/\/init\.mp4/i.test(url)) return false;
    
    // DASH/MSE numbered segments (e.g. /240/1.mp4, /720/234.mp4)
    // Pattern: path ending in /<number>.mp4
    if (/\/\d+\.mp4/i.test(url)) return false;
    
    // Segment patterns with seg/frag/chunk in the name
    if (/\/(seg|frag|chunk|segment|range)[-_]?\d*/i.test(url)) return false;
    
    // .m4s masquerading as .mp4 (fragmented mp4 segments)
    if (lower.includes('.m4s')) return false;
    
    // ── EXCLUDE: Ad/tracking/thumbnail patterns ──
    const excludePatterns = [
      'google', 'analytics', 'tracking', 'pixel', 'beacon',
      'ad.', 'ads.', 'adserver', 'doubleclick', 'facebook.com',
      'thumbnail', 'thumb', 'poster', 'preview', 'sprite',
      'heartbeat', 'telemetry', 'log', 'stat',
      'cloudfront.net/240/', 'cloudfront.net/360/', 'cloudfront.net/480/',
      'cloudfront.net/720/', 'cloudfront.net/1080/',
      // CDN segment paths (PW-style: /quality/number.mp4)
    ];
    if (excludePatterns.some(p => lower.includes(p))) return false;
    
    return true;
  }
  
  // NO: Individual .ts segments (HLS fragments)
  // NO: .m4s segments (DASH fragments) 
  return false;
}

// ─── Network Sniffing ─────────────────────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // Ignore background/service worker requests
    if (!isTrackableMediaUrl(details.url)) return;
    
    const lowerUrl = details.url.toLowerCase();
    
    if (lowerUrl.includes('.m3u8')) {
      addDetectedMedia(details.tabId, { url: details.url, type: 'hls', source: 'network' });
    } else if (lowerUrl.includes('.mpd')) {
      // PW and others often provide both DASH and HLS. We can't download DASH natively yet.
      // Check if an equivalent HLS manifest exists!
      const hlsUrl = details.url.replace(/\.mpd/i, '.m3u8').replace(/master/i, 'master'); // preserve casing if needed, though replace is case-insensitive for regex
      fetch(hlsUrl, { method: 'HEAD' })
        .then(res => {
          if (res.ok) {
            addDetectedMedia(details.tabId, { url: hlsUrl, type: 'hls', source: 'network-fallback' });
          } else {
            addDetectedMedia(details.tabId, { url: details.url, type: 'dash', source: 'network' });
          }
        })
        .catch(() => {
          addDetectedMedia(details.tabId, { url: details.url, type: 'dash', source: 'network' });
        });
    } else {
      addDetectedMedia(details.tabId, { url: details.url, type: 'direct', source: 'network' });
    }
  },
  { urls: ["<all_urls>"] }
);

// ─── Add Detected Media (with smart deduplication) ────────────────
function addDetectedMedia(tabId, mediaInfo) {
  if (!STATE.tabs.has(tabId)) {
    STATE.tabs.set(tabId, { detectedMedia: [] });
  }
  
  const tabData = STATE.tabs.get(tabId);
  const url = mediaInfo.url;
  
  // Smart dedup & merging logic
  if (url.startsWith('blob:')) {
    // 1. If we already found the true HLS/DASH manifest for this video, just enrich it with DOM metadata
    const existingNetwork = tabData.detectedMedia.find(m => m.type === 'hls' || m.type === 'dash');
    if (existingNetwork) {
      if (mediaInfo.resolution && !existingNetwork.resolution) existingNetwork.resolution = mediaInfo.resolution;
      if (mediaInfo.duration && !existingNetwork.duration) existingNetwork.duration = mediaInfo.duration;
      return; // Deduplicated!
    }
    
    // 2. Otherwise, update the existing MSE stream entry (there's only one main video player per page usually)
    const existingMse = tabData.detectedMedia.find(m => m.type === 'mse-stream');
    if (existingMse) {
      if (mediaInfo.resolution && !existingMse.resolution) existingMse.resolution = mediaInfo.resolution;
      if (mediaInfo.duration && !existingMse.duration) existingMse.duration = mediaInfo.duration;
      existingMse.url = url;
      return; // Deduplicated!
    }
  } else if (mediaInfo.type === 'hls' || mediaInfo.type === 'dash') {
    // 1. If we found a manifest, and we have a DOM-detected MSE stream, UPGRADE it!
    const existingMse = tabData.detectedMedia.find(m => m.type === 'mse-stream');
    if (existingMse) {
      existingMse.type = mediaInfo.type;
      existingMse.url = url;
      return; // Upgraded & Deduplicated!
    }
    
    // 2. Standard URL deduplication
    const baseUrl = url.split('?')[0];
    const isDuplicate = tabData.detectedMedia.some(m => m.url.split('?')[0] === baseUrl);
    if (isDuplicate) return;
  } else {
    // Regular URLs: strip query params for comparison
    const baseUrl = url.split('?')[0];
    const isDuplicate = tabData.detectedMedia.some(m => m.url.split('?')[0] === baseUrl);
    if (isDuplicate) return;
  }
  
  tabData.detectedMedia.push({
    id: crypto.randomUUID(),
    url: url,
    title: mediaInfo.title || null, // Will be enriched later
    type: mediaInfo.type || 'direct',
    source: mediaInfo.source || 'unknown',
    resolution: mediaInfo.resolution || null,
    duration: mediaInfo.duration || null,
    timestamp: Date.now(),
    qualities: null,  // Will be populated when popup requests
    estimatedSize: null
  });
  
  // Update badge
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const tabData = STATE.tabs.get(tabId);
  if (!tabData) return;
  
  const count = tabData.detectedMedia.length;
  chrome.action.setBadgeText({ tabId, text: count > 0 ? count.toString() : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#6C63FF' });
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  STATE.tabs.delete(tabId);
});

// Clean up when tab navigates to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    STATE.tabs.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

// ─── Message Handling ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  // Popup asks for detected media
  if (message.type === 'GET_DETECTED_MEDIA') {
    const tabId = message.tabId;
    const tabData = STATE.tabs.get(tabId) || { detectedMedia: [] };
    
    // Enrich titles: if we don't have a title, try to get it from the tab
    chrome.tabs.get(tabId, (tab) => {
      const pageTitle = tab ? tab.title : 'Video';
      
      const enrichedMedia = tabData.detectedMedia.map((m, index) => {
        return {
          ...m,
          title: m.title || deriveTitle(m.url, pageTitle, index, tabData.detectedMedia.length)
        };
      });
      
      sendResponse({ media: enrichedMedia });
    });
    
    return true; // Async response
  }
  
  // Content script found a media URL
  if (message.type === 'VIDGRAB_FOUND_MEDIA' && sender.tab) {
    const tabId = sender.tab.id;
    
    // MSE/blob streams are always valid — they come from actual video elements
    if (message.mediaType === 'mse-stream') {
      addDetectedMedia(tabId, {
        url: message.url,
        title: message.pageTitle || null,
        type: 'mse-stream',
        source: 'content-script',
        resolution: message.resolution,
        duration: message.duration
      });
    } else {
      // Apply smart filtering for regular URLs
      if (!isTrackableMediaUrl(message.url)) return;
      
      addDetectedMedia(tabId, {
        url: message.url,
        title: message.pageTitle || null,
        type: message.mediaType || 'direct',
        source: 'content-script'
      });
    }
  }
  
  if (message.type === 'VIDGRAB_UPDATE_QUALITIES' && sender.tab) {
    const tabId = sender.tab.id;
    const tabData = STATE.tabs.get(tabId);
    if (tabData && tabData.detectedMedia) {
      // Find the most recent MSE stream
      for (let i = tabData.detectedMedia.length - 1; i >= 0; i--) {
        if (tabData.detectedMedia[i].type === 'mse-stream') {
          tabData.detectedMedia[i].extractedQualities = message.qualities;
          break;
        }
      }
    }
  }
  
  if (message.type === 'CLEAR_MEDIA' && message.tabId) {
    if (STATE.tabs.has(message.tabId)) {
      STATE.tabs.get(message.tabId).detectedMedia = [];
      updateBadge(message.tabId);
    }
    sendResponse({ success: true });
    return true;
  }
  
  if (message.type === 'START_DIRECT_DOWNLOAD') {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename || 'video.mp4',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("VidGrab: Download failed", chrome.runtime.lastError);
      } else {
        console.log("VidGrab: Started download", downloadId);
      }
    });
  }
  
  if (message.type === 'START_HLS_DOWNLOAD') {
    // Ensure offscreen document exists and forward the message
    setupOffscreenDocument('src/offscreen/offscreen.html').then(() => {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'START_DOWNLOAD_TIER1',
        data: {
          url: message.url,
          title: message.filename || 'video'
        }
      });
    });
  }
  
  // Popup asks to parse an HLS manifest for qualities
  if (message.type === 'PARSE_HLS_MANIFEST') {
    parseHLSManifest(message.url, message.tabId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Async
  }
  
  return true;
});

// ─── Title Derivation ─────────────────────────────────────────────
function deriveTitle(url, pageTitle, index, totalCount) {
  // Try to extract a meaningful name from the URL
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    
    // Remove extension
    const nameWithoutExt = filename.replace(/\.(m3u8|mp4|webm|m4v|mov)(\?.*)?$/i, '');
    
    // If the filename is meaningful (not just random hashes), use it
    if (nameWithoutExt && nameWithoutExt.length > 3 && !/^[a-f0-9]+$/i.test(nameWithoutExt)) {
      // Clean up: replace underscores/hyphens with spaces, capitalize
      return nameWithoutExt
        .replace(/[_\-]+/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
        .trim();
    }
  } catch (e) {}
  
  // Fall back to page title
  if (pageTitle && pageTitle !== 'New Tab' && pageTitle.length > 0) {
    // If there are multiple videos, add numbering
    if (totalCount > 1) {
      return `${pageTitle} (Video ${index + 1})`;
    }
    return pageTitle;
  }
  
  return `Video ${index + 1}`;
}

// ─── HLS Manifest Parser (runs in service worker) ─────────────────
async function parseHLSManifest(masterUrl, tabId) {
  try {
    const response = await fetch(masterUrl, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const text = await response.text();
    const lines = text.split('\n');
    
    // Check if this is a master playlist (has variants) or a media playlist
    const isMaster = text.includes('#EXT-X-STREAM-INF');
    
    if (!isMaster) {
      // It's a media playlist — single quality, count segments for duration
      const segmentInfo = parseMediaPlaylist(text);
      return {
        type: 'media',
        qualities: [{
          label: 'Original',
          bandwidth: 0,
          url: masterUrl,
          segments: segmentInfo.segmentCount,
          duration: segmentInfo.duration,
          estimatedSize: null
        }]
      };
    }
    
    // Parse master playlist for quality variants
    const qualities = [];
    let currentAttrs = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        currentAttrs = parseHLSAttributes(line.substring(18));
      } else if (currentAttrs && line && !line.startsWith('#')) {
        // This is the variant URL
        const variantUrl = resolveUrl(line, masterUrl);
        
        const resolution = currentAttrs.RESOLUTION || '';
        const bandwidth = parseInt(currentAttrs.BANDWIDTH) || 0;
        const height = resolution ? resolution.split('x')[1] : null;
        
        let label = 'Unknown';
        if (height) {
          const h = parseInt(height);
          if (h >= 2160) label = '4K Ultra HD';
          else if (h >= 1080) label = '1080p Full HD';
          else if (h >= 720) label = '720p HD';
          else if (h >= 480) label = '480p SD';
          else if (h >= 360) label = '360p Low';
          else if (h >= 240) label = '240p Min';
          else label = `${h}p`;
        } else if (bandwidth) {
          if (bandwidth > 5000000) label = 'High Quality';
          else if (bandwidth > 2000000) label = 'Medium Quality';
          else label = 'Low Quality';
        }
        
        qualities.push({
          label: label,
          bandwidth: bandwidth,
          resolution: resolution,
          url: variantUrl,
          estimatedSize: null // Will calculate after we know duration
        });
        
        currentAttrs = null;
      }
    }
    
    // Sort: highest quality first
    qualities.sort((a, b) => b.bandwidth - a.bandwidth);
    
    // Try to get duration from the first variant to estimate sizes
    if (qualities.length > 0) {
      try {
        const firstVariantResp = await fetch(qualities[0].url, { credentials: 'include' });
        const firstVariantText = await firstVariantResp.text();
        const segInfo = parseMediaPlaylist(firstVariantText);
        
        if (segInfo.duration > 0) {
          for (const q of qualities) {
            const bytes = (q.bandwidth * segInfo.duration) / 8;
            q.estimatedSize = formatBytes(bytes);
            q.duration = segInfo.duration;
          }
        }
      } catch (e) {
        console.warn('VidGrab: Could not fetch variant for duration', e);
      }
    }
    
    return { type: 'master', qualities };
    
  } catch (error) {
    console.error('VidGrab: Failed to parse HLS manifest', error);
    return { error: error.message, qualities: [] };
  }
}

function parseMediaPlaylist(text) {
  const lines = text.split('\n');
  let totalDuration = 0;
  let segmentCount = 0;
  
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const dur = parseFloat(line.split(':')[1].split(',')[0]);
      if (!isNaN(dur)) totalDuration += dur;
      segmentCount++;
    }
  }
  
  return { duration: totalDuration, segmentCount };
}

function parseHLSAttributes(attrString) {
  const attrs = {};
  const regex = /([A-Z0-9\-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.substring(1, value.length - 1);
    }
    attrs[match[1]] = value;
  }
  return attrs;
}

function resolveUrl(url, baseUrl) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try { return new URL(url, baseUrl).href; } catch (e) { return url; }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
