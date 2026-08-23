// Temporary probe. DELETE with this branch.
// Tests whether a serverless function can require a module from src/.
const proof = require('../src/shared/credentialProof');
const { verifySignature } = require('verify-xrpl-signature');
const codec = require('ripple-binary-codec');

module.exports = async (req, res) => {
  try {
    const blob = req.query && req.query.blob;
    if (!blob) {
      return res.status(200).json({
        ok: true,
        sharedModuleLoaded: true,
        memo: proof.PROOF_MEMO,
        exports: Object.keys(proof),
        note: 'pass ?blob=<hex> to test verification',
      });
    }
    let r, decoded;
    try {
      r = verifySignature(blob);
      decoded = codec.decode(blob);
    } catch (e) {
      return res.status(400).json({ ok: false, code: 'PROOF_UNDECODABLE', error: String(e.message) });
    }
    if (r.signatureValid !== true) return res.status(400).json({ ok: false, code: 'PROOF_SIGNATURE_INVALID' });
    const memo = proof.readProofMemo(decoded);
    if (memo === null) return res.status(400).json({ ok: false, code: 'PROOF_MEMO_MISSING', expected: proof.PROOF_MEMO });
    res.status(200).json({ ok: true, signedBy: r.signedBy, memoOk: true, txType: decoded.TransactionType });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message) });
  }
};
