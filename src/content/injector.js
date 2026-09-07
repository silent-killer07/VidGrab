// injector.js
// Runs in the MAIN world (page context) to intercept network and media APIs

(function() {
  console.log("VidGrab: MAIN world injector running");

  // 1. Fetch Interceptor (Tier 1 detection)
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const url = args[0] instanceof Request ? args[0].url : args[0];
      if (typeof url === 'string') {
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.webm')) {
          // Send to content script (NOT .ts — those are HLS fragments, not separate videos)
          window.postMessage({ type: 'VIDGRAB_URL', url: url }, '*');
        }
      }
    } catch (e) {
      // Ignore errors in interception logic
    }
    return originalFetch.apply(this, args);
  };

  // 2. XHR Interceptor (Tier 1 detection for older players)
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try {
      if (typeof url === 'string') {
        if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.webm')) {
          window.postMessage({ type: 'VIDGRAB_URL', url: url }, '*');
        }
      }
    } catch (e) {
      // Ignore
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  // 3. SourceBuffer.appendBuffer Interceptor (Tier 2 capture)
  // This captures the media segments right before they are decoded and played
  if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    
    SourceBuffer.prototype.appendBuffer = function(data) {
      try {
        // We need to copy the buffer or pass it if it's an ArrayBuffer
        // The player needs the original data, so we send a copy to our content script
        let bufferCopy;
        if (data instanceof ArrayBuffer) {
          bufferCopy = data.slice(0);
        } else if (ArrayBuffer.isView(data)) {
          bufferCopy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }

        if (bufferCopy) {
          const mimeType = this.mimeType || 'unknown'; // mimeType might not always be accessible directly, but try
          
          window.postMessage({ 
            type: 'VIDGRAB_SEGMENT',
            mimeType: mimeType,
            buffer: bufferCopy
          }, '*', [bufferCopy]); // Transfer ownership of the copy to avoid structured clone overhead
        }
      } catch (e) {
        console.error("VidGrab: Error in appendBuffer hook", e);
      }
      
      // Call the original method so the video plays normally
      return originalAppendBuffer.apply(this, arguments);
    };
    console.log("VidGrab: SourceBuffer.appendBuffer hooked");
  } else {
    console.log("VidGrab: Media Source Extensions not supported or not used on this page");
  }

  // 4. Quality Extractor
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data.type !== 'VIDGRAB_GET_QUALITIES') return;
    
    let qualities = [];
    
    try {
      // ─── YouTube Player API ───
      const ytPlayer = document.querySelector('.html5-video-player');
      if (ytPlayer && typeof ytPlayer.getAvailableQualityLevels === 'function') {
        const levels = ytPlayer.getAvailableQualityLevels();
        // YouTube returns array like ["highres", "hd1080", "hd720", "large", "medium", "small", "tiny", "auto"]
        // We filter out 'auto' and map them to readable formats
        const labelMap = {
          'highres': '4K/8K (High-Res)',
          'hd2880': '5K (2880p)',
          'hd2160': '4K (2160p)',
          'hd1440': '1440p',
          'hd1080': '1080p',
          'hd720': '720p',
          'large': '480p',
          'medium': '360p',
          'small': '240p',
          'tiny': '144p'
        };
        
        qualities = levels
          .filter(lvl => lvl !== 'auto')
          .map(lvl => ({
            id: lvl,
            label: labelMap[lvl] || lvl,
            isCurrent: lvl === ytPlayer.getPlaybackQuality()
          }));
      }
      
      // ─── PW / Generic Shaka Player API ───
      // If we can find window.player or window.shaka
      if (qualities.length === 0 && window.shakaPlayerInstance) {
        // Pseudo-code depending on how PW exposes it
        const tracks = window.shakaPlayerInstance.getVariantTracks();
        if (tracks && tracks.length > 0) {
          // Sort by height descending and dedup
          const uniqueHeights = new Set();
          tracks.sort((a, b) => (b.height || 0) - (a.height || 0)).forEach(t => {
            if (t.height && !uniqueHeights.has(t.height)) {
              uniqueHeights.add(t.height);
              qualities.push({
                id: t.id,
                label: `${t.height}p`,
                isCurrent: t.active
              });
            }
          });
        }
      }
      
      // Additional fallback: look for PW's bitmovin player or specific video DOM elements
      // ... (Implementation can expand as needed)
      
    } catch (e) {
      console.warn('VidGrab: Failed to extract player qualities', e);
    }
    
    // Only send if we found something useful
    if (qualities.length > 0) {
      window.postMessage({
        type: 'VIDGRAB_QUALITIES',
        qualities: qualities
      }, '*');
    }
  });

})();
