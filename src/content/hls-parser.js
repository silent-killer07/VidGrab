// hls-parser.js
// Lightweight M3U8 parser

class HLSParser {
  static parseMaster(m3u8Text, baseUrl) {
    const lines = m3u8Text.split('\n');
    const qualities = [];
    let currentQuality = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        currentQuality = this.parseAttributes(line.substring(18));
      } else if (line.startsWith('#') || !currentQuality) {
        // Other tags or comments, ignore
      } else {
        // This is a URI
        currentQuality.url = this.resolveUrl(line, baseUrl);
        
        // Create a friendly label
        let label = "Unknown";
        if (currentQuality.RESOLUTION) {
          label = currentQuality.RESOLUTION.split('x')[1] + 'p';
        } else if (currentQuality.BANDWIDTH) {
          label = Math.round(currentQuality.BANDWIDTH / 1000) + 'k';
        }
        
        qualities.push({
          label: label,
          bandwidth: parseInt(currentQuality.BANDWIDTH) || 0,
          resolution: currentQuality.RESOLUTION,
          url: currentQuality.url
        });
        currentQuality = null;
      }
    }
    
    // Sort by bandwidth descending
    return qualities.sort((a, b) => b.bandwidth - a.bandwidth);
  }

  static parseAttributes(attrString) {
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

  static resolveUrl(url, baseUrl) {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    try {
      return new URL(url, baseUrl).href;
    } catch (e) {
      return url;
    }
  }
}

// Export if module environment, otherwise attach to window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HLSParser;
} else if (typeof window !== 'undefined') {
  window.HLSParser = HLSParser;
}
