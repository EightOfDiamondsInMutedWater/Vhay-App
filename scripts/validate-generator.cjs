// Read-only: prove the corrected condition/fulfillment round-trips per spec.
const cc = require('five-bells-condition');
const TEST_ID = '0641C706F9C6BB3B75EA31B353A54E2EFAC423498EF25045'; // any PO issuance ID

// --- replicate the app's generateEscrowCondition ---
const preimage = Buffer.from(TEST_ID, 'hex');
const f = new cc.PreimageSha256();
f.setPreimage(preimage);
const condition  = f.getConditionBinary().toString('hex').toUpperCase();
const fulfillment = f.serializeBinary().toString('hex').toUpperCase();
console.log('preimage bytes:', preimage.length);
console.log('condition:  ', condition);
console.log('fulfillment:', fulfillment);

// --- what rippled does at EscrowFinish: parse fulfillment, derive its condition, compare ---
const parsed = cc.Fulfillment.fromBinary(Buffer.from(fulfillment, 'hex'));
const derivedCondition = parsed.getConditionBinary().toString('hex').toUpperCase();
console.log('\nderived-from-fulfillment condition:', derivedCondition);
console.log('ROUND-TRIP VALID?', derivedCondition === condition);

// --- spec sanity: condition fingerprint must equal SHA256(preimage) ---
const crypto = require('crypto');
const sha = crypto.createHash('sha256').update(preimage).digest('hex').toUpperCase();
const fingerprint = condition.slice(8, 8+64); // skip A0 25 80 20, take 32-byte hash
console.log('SHA256(preimage):', sha);
console.log('condition fingerprint:', fingerprint);
console.log('FINGERPRINT MATCHES SHA256(preimage)?', sha === fingerprint);
