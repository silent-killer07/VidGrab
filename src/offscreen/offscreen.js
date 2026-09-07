// offscreen.js
// Heavy lifting: fetching, decrypting, and merging segments

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'START_DOWNLOAD_TIER1':
      startTier1Download(message.data);
      sendResponse({ status: 'started' });
      break;
    // other tiers will be added here
  }
  return true;
});

async function fetchAndParseM3U8(url) {
  const response = await fetch(url);
  const text = await response.text();
  const lines = text.split('\n');
  const segments = [];
  let baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
  
  for (let line of lines) {
    line = line.trim();
    // In a real scenario we'd also parse #EXT-X-KEY for AES-128 decryption here
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('http')) {
      segments.push(line);
    } else {
      segments.push(baseUrl + line);
    }
  }
  return segments;
}

let isCancelled = false;
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CANCEL_DOWNLOAD') isCancelled = true;
});

async function startTier1Download(data) {
  const { url, title } = data;
  isCancelled = false;
  
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
    
    const totalSegments = segments.length;
    let startTime = Date.now();
    let bytesDownloaded = 0;
    
    for (let i = 0; i < totalSegments; i++) {
      if (isCancelled) {
        worker.terminate();
        return;
      }
      
      const tsResponse = await fetch(segments[i]);
      if (!tsResponse.ok) throw new Error(`Failed to fetch segment ${i}`);
      const tsBuffer = await tsResponse.arrayBuffer();
      
      bytesDownloaded += tsBuffer.byteLength;
      
      worker.postMessage({ type: 'PUSH', data: tsBuffer }, [tsBuffer]);
      
      // Calculate speed and ETA
      const elapsedSec = (Date.now() - startTime) / 1000;
      const speedBps = bytesDownloaded / elapsedSec;
      const speedMBps = (speedBps / (1024 * 1024)).toFixed(1);
      const percent = Math.round(((i + 1) / totalSegments) * 100);
      const remainingBytes = (bytesDownloaded / (i + 1)) * (totalSegments - i - 1);
      const etaSec = Math.round(remainingBytes / speedBps);
      
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        progress: percent,
        segmentsDownloaded: i + 1,
        totalSegments: totalSegments,
        speed: `${speedMBps} MB/s`,
        eta: `${etaSec}s`
      });
    }
    
    worker.postMessage({ type: 'FLUSH' });
    
    // Wait briefly for worker to flush remaining buffers
    await new Promise(r => setTimeout(r, 1000));
    worker.terminate();
    
    const finalBlob = new Blob(mp4Chunks, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(finalBlob);
    const safeTitle = (title || 'video').replace(/[<>:"/\\|?*]+/g, '_') + '.mp4';
    
    chrome.downloads.download({
      url: blobUrl,
      filename: safeTitle,
      saveAs: false
    }, () => {
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE' });
      // Clean up blob URL after download starts
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    });
    
  } catch (error) {
    console.error("VidGrab Offscreen: Download failed", error);
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_ERROR',
      error: error.message
    });
  }
}
