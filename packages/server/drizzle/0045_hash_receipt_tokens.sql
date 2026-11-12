-- Hand-written: digital receipt links are guarded only by their token, so the table keeps its SHA-256 (as for table QR
-- tokens). Existing links keep working: their stored tokens are hashed in place.
UPDATE digital_receipts SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex');
