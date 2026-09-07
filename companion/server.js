const express = require('express');
const cors = require('cors');
const ytDlp = require('yt-dlp-exec');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

app.post('/api/extract', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Extracting: ${url}`);
    
    try {
        const output = await ytDlp(url, {
            dumpJson: true,
            noWarnings: true,
            noCallHome: true,
            format: 'best[ext=mp4]'
        });

        res.json({
            title: output.title,
            url: output.url,
            duration: output.duration,
            resolution: `${output.width}x${output.height}`
        });

    } catch (err) {
        console.error("Error extracting:", err.message);
        res.status(500).json({ error: 'Failed to extract video' });
    }
});

app.listen(port, () => {
    console.log(`VidGrab Companion Server running on http://localhost:${port}`);
    console.log(`Leave this window open while downloading YouTube videos via the extension.`);
});
