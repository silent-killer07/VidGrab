// content.js
// Scans the DOM for actual playing videos and reports to background

console.log("VidGrab: Content script loaded on", window.location.hostname);

let reportedUrls = new Set();
let lastScannedUrl = '';

// Safe wrapper — chrome.runtime becomes undefined after extension reload
function safeSend(msg) {
  try {
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(msg);
    }
  } catch (e) {
    // Extension context invalidated, ignore silently
  }
}

// 1. Inject the MAIN world script (injector.js)
function injectScript() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/injector.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.error("VidGrab: Failed to inject script", e);
  }
}

injectScript();

// 2. Smart DOM Scanner — finds ACTUAL playing/playable videos
function scanDOMForVideos() {
  const videos = Array.from(document.querySelectorAll('video'));
  
  // Find the MAIN video — the one with the largest dimensions
  // Skip tiny ones (previews, thumbnails, ads)
  let mainVideo = null;
  let maxArea = 0;
  
  for (const video of videos) {
    // Must have a source
    const src = video.currentSrc || video.src;
    if (!src) continue;
    
    // Skip very short videos (< 10 seconds = likely ads)
    if (video.duration && video.duration < 10) continue;
    
    // Calculate area (use element dimensions as fallback)
    const w = video.videoWidth || video.clientWidth || 0;
    const h = video.videoHeight || video.clientHeight || 0;
    const area = w * h;
    
    if (area > maxArea) {
      maxArea = area;
      mainVideo = video;
    }
  }
  
  // Only report the main (largest) video
  if (!mainVideo) return;
  
  const src = mainVideo.currentSrc || mainVideo.src;
  
  // ─── BLOB / MSE VIDEOS (YouTube, PW.live, etc.) ──────────────
  if (src.startsWith('blob:')) {
    const pageUrl = window.location.href.split('&')[0];
    const blobKey = `blob-main-${pageUrl}`;
    
    if (reportedUrls.has(blobKey)) return;
    
    const reportBlob = () => {
      if (!mainVideo.duration || isNaN(mainVideo.duration) || mainVideo.duration < 10) return;
      if (reportedUrls.has(blobKey)) return;
      reportedUrls.add(blobKey);
      
      const title = getVideoTitle(mainVideo);
      const resolution = mainVideo.videoWidth && mainVideo.videoHeight 
        ? `${mainVideo.videoWidth}x${mainVideo.videoHeight}` : null;
      
      console.log("VidGrab: Detected main video:", title, resolution, Math.round(mainVideo.duration) + 's');
      
      // Ask injector for available quality levels
      window.postMessage({ type: 'VIDGRAB_GET_QUALITIES' }, '*');
      
      safeSend({
        type: 'VIDGRAB_FOUND_MEDIA',
        url: src,
        pageTitle: title,
        mediaType: 'mse-stream',
        resolution: resolution,
        duration: Math.round(mainVideo.duration)
      });
    };
    
    if (mainVideo.duration && !isNaN(mainVideo.duration) && mainVideo.duration > 10) {
      reportBlob();
    } else {
      mainVideo.addEventListener('loadedmetadata', reportBlob, { once: true });
      mainVideo.addEventListener('durationchange', reportBlob, { once: true });
      setTimeout(reportBlob, 2000);
      setTimeout(reportBlob, 5000);
    }
    return;
  }
  
  // ─── DIRECT VIDEO FILES ──────────────────────────────────────
  if (src.includes('.mp4') || src.includes('.webm') || src.includes('.m3u8') || src.includes('.m4v')) {
    reportMedia(src, getVideoTitle(mainVideo));
  }
}

// 3. Try to extract a meaningful title for the video
function getVideoTitle(videoElement) {
  const hostname = window.location.hostname;
  
  // ─── YouTube-specific title extraction ──────────────────────
  if (hostname.includes('youtube.com')) {
    // YouTube has the title in specific elements
    const ytTitle = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, ' +
      '#title h1 yt-formatted-string, ' +
      'h1.title, ' +
      '#info-contents h1'
    );
    if (ytTitle && ytTitle.textContent.trim()) return ytTitle.textContent.trim();
  }
  
  // ─── PW.live specific ──────────────────────────────────────
  if (hostname.includes('pw.live') || hostname.includes('physicswallah')) {
    const pwTitle = document.querySelector('.lecture-heading, .video-title, h1, h2');
    if (pwTitle && pwTitle.textContent.trim()) return pwTitle.textContent.trim();
  }
  
  // Strategy 1: Check aria-label or title attribute on the video
  if (videoElement.title) return videoElement.title;
  if (videoElement.getAttribute('aria-label')) return videoElement.getAttribute('aria-label');
  
  // Strategy 2: Check parent containers for heading elements
  let parent = videoElement.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    const heading = parent.querySelector('h1, h2, h3, .title, [class*="title"], [class*="name"]');
    if (heading && heading.textContent.trim().length > 3) {
      return heading.textContent.trim();
    }
    parent = parent.parentElement;
  }
  
  // Strategy 3: og:title meta tag
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle && ogTitle.content) return ogTitle.content;
  
  // Strategy 4: Page title
  const pageTitle = document.title;
  if (pageTitle && pageTitle.length > 0 && pageTitle !== 'New Tab') {
    // Clean up common suffixes
    return pageTitle
      .replace(/ - YouTube$/i, '')
      .replace(/ \| PW$/i, '')
      .trim();
  }
  
  return null;
}

// 4. Watch for dynamically added videos (SPAs like YouTube, pw.live)
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeName === 'VIDEO') {
        setTimeout(() => scanDOMForVideos(), 1000);
        return;
      }
      if (node.querySelectorAll) {
        const videos = node.querySelectorAll('video');
        if (videos.length > 0) {
          setTimeout(() => scanDOMForVideos(), 1000);
          return;
        }
      }
    }
  }
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

// 5. SPA Navigation Detection (YouTube, pw.live use client-side routing)
// When the URL changes without a page reload, we need to re-scan
function watchForSPANavigation() {
  setInterval(() => {
    const currentUrl = window.location.href.split('&')[0];
    if (currentUrl !== lastScannedUrl) {
      lastScannedUrl = currentUrl;
      console.log("VidGrab: SPA navigation detected, re-scanning...");
      // Clear previous detections for this "page"
      reportedUrls.clear();
      // Wait for new video to load
      setTimeout(scanDOMForVideos, 1500);
      setTimeout(scanDOMForVideos, 3000);
      setTimeout(scanDOMForVideos, 6000);
    }
  }, 1500);
}

watchForSPANavigation();

// 6. Initial scans (staggered to catch videos that load slowly)
lastScannedUrl = window.location.href.split('&')[0];
setTimeout(scanDOMForVideos, 1000);
setTimeout(scanDOMForVideos, 3000);
setTimeout(scanDOMForVideos, 8000); // Late scan for very slow-loading players

// 7. Listen for messages from the injected script (MAIN world)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  
  if (event.data.type === 'VIDGRAB_URL') {
    const url = event.data.url;
    // Only report m3u8 master playlists and direct video files
    if (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.webm')) {
      reportMedia(url, getVideoTitle(document.querySelector('video')));
    }
  }
  
  if (event.data.type === 'VIDGRAB_QUALITIES') {
    // Send qualities to background script to update the last detected MSE stream
    safeSend({
      type: 'VIDGRAB_UPDATE_QUALITIES',
      qualities: event.data.qualities
    });
  }
});

// 8. Report media to background (with deduplication)
function reportMedia(url, title) {
  const baseUrl = url.split('?')[0];
  if (reportedUrls.has(baseUrl)) return;
  reportedUrls.add(baseUrl);
  
  safeSend({
    type: 'VIDGRAB_FOUND_MEDIA',
    url: url,
    pageTitle: title || document.title,
    mediaType: url.includes('.m3u8') ? 'hls' : 'direct'
  });
}

// 9. Listen for messages from background/popup
try {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'FORCE_RESCAN') {
      reportedUrls.clear(); // Clear local cache to allow re-detecting
      scanDOMForVideos();
      sendResponse({ success: true });
    }
    return true;
  });
} catch(e) {
  // Ignored if context invalidated
}
