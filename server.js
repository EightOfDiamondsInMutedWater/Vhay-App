const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.get('/ipfs/:hash', async (req, res) => {
  try {
    const response = await axios.get(`https://cloudflare-ipfs.com/ipfs/${req.params.hash}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'IPFS fetch failed' });
  }
});
app.listen(4000, () => console.log('IPFS proxy on port 4000'));
