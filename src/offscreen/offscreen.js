// offscreen.js
// Heavy lifting: fetching, decrypting, and merging segments

const activeDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_DOWNLOAD_TIER1':
      startTier1Download(message.data);
      sendResponse({ status: 'started' });
      break;
    case 'CANCEL_DOWNLOAD':
      if (activeDownloads.has(message.id)) {
        activeDownloads.get(message.id).isCancelled = true;
      }
      break;
  }
  return true;
});

async function fetchAndParseM3U8(url) {
  const response = await fetch(url);
  const text = await response.text();
  const lines = text.split('\n');
  const segments = [];
  
  const urlObj = new URL(url);
  const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
  const rootUrl = urlObj.origin;
  
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    
    if (line.startsWith('http')) {
      segments.push(line);
    } else if (line.startsWith('/')) {
      segments.push(rootUrl + line); // Absolute path from domain root
    } else {
      segments.push(baseUrl + line); // Relative path from playlist directory
    }
  }
  return segments;
}

function reportProgress(state, pushedSegments, totalSegments) {
  const elapsedSec = (Date.now() - state.startTime) / 1000;
  if (elapsedSec < 1) return; // Prevent divide by zero and erratic initial speeds
  
  const speedBps = state.bytesDownloaded / elapsedSec;
  const speedMBps = (speedBps / (1024 * 1024)).toFixed(1);
  const percent = Math.round((pushedSegments / totalSegments) * 100);
  
  const remainingBytes = (state.bytesDownloaded / pushedSegments) * (totalSegments - pushedSegments);
  const etaSec = Math.round(remainingBytes / speedBps) || 0;
  
  // Throttle messages to prevent IPC overload
  if (Date.now() - state.lastReportTime > 500) {
    state.lastReportTime = Date.now();
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_PROGRESS',
      id: state.id,
      progress: percent,
      segmentsDownloaded: pushedSegments,
      totalSegments: totalSegments,
      speed: `${speedMBps} MB/s`,
      eta: `${etaSec}s`
    });
  }
}

async function startTier1Download(data) {
  const { id, url, title } = data;
  
  const downloadState = {
    id,
    isCancelled: false,
    startTime: Date.now(),
    lastReportTime: 0,
    bytesDownloaded: 0
  };
  activeDownloads.set(id, downloadState);
  
  console.log(`VidGrab Offscreen: Starting Tier 1 download for ${title}`);
  
  try {
    const segments = await fetchAndParseM3U8(url);
    if (segments.length === 0) throw new Error("No video segments found in playlist");
    
    const worker = new Worker('transmuxer-worker.js');
    const mp4Chunks = [];
    
    worker.onmessage = (e) => {
      if (e.data.type === 'DATA') {
        if (e.data.initSegment) mp4Chunks.push(e.data.initSegment);
        if (e.data.dataSegment) mp4Chunks.push(e.data.dataSegment);
      }
    };
    worker.postMessage({ type: 'INIT' });
    
    // Concurrency Engine
    const CONCURRENCY = 5; // 5 chunks at a time for high speed
    let nextPushIndex = 0;
    const downloadedBuffers = {};
    let nextFetchIndex = 0;
    let activeFetches = 0;
    
    await new Promise((resolve, reject) => {
      function spawn() {
        if (downloadState.isCancelled) return reject(new Error("Cancelled by user"));
        
        while (activeFetches < CONCURRENCY && nextFetchIndex < segments.length) {
          const i = nextFetchIndex++;
          activeFetches++;
          
          fetch(segments[i])
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.arrayBuffer();
            })
            .then(tsBuffer => {
              downloadState.bytesDownloaded += tsBuffer.byteLength;
              downloadedBuffers[i] = tsBuffer;
              
              // Push strictly in order to the muxer
              while (downloadedBuffers[nextPushIndex]) {
                 worker.postMessage({ type: 'PUSH', data: downloadedBuffers[nextPushIndex] }, [downloadedBuffers[nextPushIndex]]);
                 delete downloadedBuffers[nextPushIndex];
                 nextPushIndex++;
              }
              
              reportProgress(downloadState, nextPushIndex, segments.length);
              activeFetches--;
              
              if (nextPushIndex === segments.length) {
                resolve();
              } else {
                spawn();
              }
            })
            .catch(err => {
              if (!downloadState.isCancelled) {
                downloadState.isCancelled = true;
                reject(new Error(`Segment ${i} failed: ${err.message}`));
              }
            });
        }
      }
      spawn();
    });
    
    worker.postMessage({ type: 'FLUSH' });
    
    // Wait briefly for worker to flush remaining buffers
    await new Promise(r => setTimeout(r, 1000));
    worker.terminate();
    
    if (downloadState.isCancelled) throw new Error("Cancelled by user");
    
    const finalBlob = new Blob(mp4Chunks, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(finalBlob);
    const safeTitle = (title || 'video').replace(/[<>:"/\\|?*]+/g, '_') + '.mp4';
    
    chrome.downloads.download({
      url: blobUrl,
      filename: safeTitle,
      saveAs: false
    }, () => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE', id });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      activeDownloads.delete(id);
    });
    
  } catch (error) {
    console.error("VidGrab Offscreen: Download failed", error);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', id, error: error.message });
    activeDownloads.delete(id);
  }
}
