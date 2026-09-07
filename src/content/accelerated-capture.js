// accelerated-capture.js
// Tier 3: Accelerated frame capture for Widevine DRM
// NOTE: This runs in MAIN world — no chrome.runtime available. Uses postMessage.

(function() {
  console.log("VidGrab: Accelerated capture module loaded");

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data.type !== 'VIDGRAB_START_TIER3') return;

    const video = document.querySelector('video');
    if (!video) {
      console.error("VidGrab: No video element found for Tier 3 capture");
      return;
    }

    console.log("VidGrab: Starting Tier 3 Accelerated Capture");

    // 1. Pause the video
    video.pause();
    const originalMuted = video.muted;
    video.muted = true; // Must be muted for fast seeking without awful noise
    
    // 2. Setup canvas and context
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    
    // 3. Setup MediaRecorder with 0fps (manual frame push)
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    
    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 5000000 // 5 Mbps
    });
    
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      
      // Send back to content script via postMessage (MAIN world has no chrome.runtime)
      window.postMessage({
        type: 'VIDGRAB_TIER3_COMPLETE',
        blobUrl: url
      }, '*');
      
      // Restore video state
      video.muted = originalMuted;
    };
    
    recorder.start();
    
    // 4. Accelerated seek loop
    const frameRate = 30;
    const timeStep = 1 / frameRate;
    const duration = video.duration;
    
    video.currentTime = 0;
    
    // Wait for initial seek
    await new Promise(r => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        r();
      };
      video.addEventListener('seeked', onSeeked);
    });

    let currentTime = 0;
    
    while (currentTime < duration) {
      // Draw frame
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      // Request frame to be recorded
      if (track.requestFrame) {
        track.requestFrame();
      }
      
      // Advance time
      currentTime += timeStep;
      if (currentTime > duration) currentTime = duration;
      
      video.currentTime = currentTime;
      
      // Wait for seek to complete before next frame
      await new Promise(r => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          r();
        };
        video.addEventListener('seeked', onSeeked);
        
        // Timeout fallback just in case
        setTimeout(r, 100);
      });
      
      // Yield to main thread briefly to avoid freezing the browser completely
      await new Promise(r => setTimeout(r, 1));
      
      // Report progress occasionally via postMessage (no chrome.runtime in MAIN world)
      if (Math.random() < 0.05) {
        window.postMessage({
          type: 'VIDGRAB_TIER3_PROGRESS',
          progress: Math.round((currentTime / duration) * 100)
        }, '*');
      }
    }
    
    recorder.stop();
  });
})();

