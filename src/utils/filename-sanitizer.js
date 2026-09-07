// filename-sanitizer.js

function sanitizeFilename(name, fallback = 'video') {
  if (!name) return fallback;
  
  // Remove illegal characters
  let clean = name.replace(/[\\/:*?"<>|]/g, '-');
  
  // Trim and ensure max length
  clean = clean.trim();
  if (clean.length > 150) {
    clean = clean.substring(0, 150).trim();
  }
  
  return clean || fallback;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanitizeFilename };
}
