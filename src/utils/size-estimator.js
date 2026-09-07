// size-estimator.js
// Estimates download sizes

function estimateSize(media) {
  if (media.bandwidth && media.duration) {
    const bytes = (media.bandwidth * media.duration) / 8;
    return formatBytes(bytes);
  }
  return 'Unknown';
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { estimateSize, formatBytes };
}
