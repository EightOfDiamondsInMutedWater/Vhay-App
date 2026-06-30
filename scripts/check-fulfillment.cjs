// Read-only: reconstruct the crypto-condition from the PO issuance ID and compare
// against the condition on the live escrow. Signs nothing, submits nothing.
const cc = require('five-bells-condition');

const PO_ISSUANCE_ID = '0641C706F9C6BB3B75EA31B353A54E2EFAC423498EF25045';
const LIVE_CONDITION = 'A0258020A3FE20D7620B7B61EC36D36B47AF8B0865220E08EB5312E84C59D830A4250408810130';

function build(label, preimageBuf) {
  const f = new cc.PreimageSha256();
  f.setPreimage(preimageBuf);
  const condition = f.getConditionBinary().toString('hex').toUpperCase();
  const fulfillment = f.serializeBinary().toString('hex').toUpperCase();
  const match = condition === LIVE_CONDITION.toUpperCase();
  console.log(`\n[${label}] preimage bytes=${preimageBuf.length}`);
  console.log('  condition:  ', condition);
  console.log('  MATCHES live escrow condition?', match);
  if (match) console.log('  >>> Fulfillment your EscrowFinish must submit:\n      ', fulfillment);
  return match;
}

console.log('Live escrow condition:', LIVE_CONDITION);
// Hypothesis A: preimage = issuance ID interpreted as HEX bytes (24 bytes)
build('A: issuanceID as hex bytes', Buffer.from(PO_ISSUANCE_ID, 'hex'));
// Hypothesis B: preimage = issuance ID interpreted as ASCII/UTF-8 string (48 bytes)
build('B: issuanceID as utf8 string', Buffer.from(PO_ISSUANCE_ID, 'utf8'));
// Hypothesis C: preimage = lowercase issuance ID as utf8
build('C: lowercase issuanceID as utf8', Buffer.from(PO_ISSUANCE_ID.toLowerCase(), 'utf8'));
