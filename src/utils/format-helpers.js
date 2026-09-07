// format-helpers.js

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  } else if (m > 0) {
    return `${m}m ${s}s`;
  } else {
    return `${s}s`;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatDuration };
}
