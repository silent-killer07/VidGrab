// transmuxer-worker.js
// Web Worker for mux.js to run off the main thread

importScripts('../../lib/mux.min.js');

let transmuxer = null;

self.addEventListener('message', function(e) {
  const { type, data } = e.data;

  switch (type) {
    case 'INIT':
      // Initialize transmuxer
      transmuxer = new muxjs.mp4.Transmuxer({
        remux: true,
        keepOriginalTimestamps: true
      });
      
      transmuxer.on('data', (segment) => {
        // Send transmuxed fMP4 data back
        const initSegment = segment.initSegment;
        const dataSegment = segment.data;
        
        self.postMessage({
          type: 'DATA',
          initSegment: initSegment.buffer,
          dataSegment: dataSegment.buffer
        }, [initSegment.buffer, dataSegment.buffer]);
      });
      
      transmuxer.on('done', () => {
        self.postMessage({ type: 'DONE' });
      });
      break;

    case 'PUSH':
      if (transmuxer && data) {
        // Push TS segment to transmuxer
        const uint8Array = new Uint8Array(data);
        transmuxer.push(uint8Array);
      }
      break;

    case 'FLUSH':
      if (transmuxer) {
        transmuxer.flush();
      }
      break;
      
    case 'RESET':
      if (transmuxer) {
        // mux.js doesn't have a clean reset, often easier to recreate
        transmuxer = new muxjs.mp4.Transmuxer({
          remux: true,
          keepOriginalTimestamps: true
        });
      }
      break;
  }
});
