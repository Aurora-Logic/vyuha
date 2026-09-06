-- Backfill vouchers.party_id where party_id is null by matching party_name with parties.name on connection_id
UPDATE vouchers
   SET party_id = p.id
  FROM parties p
 WHERE vouchers.connection_id = p.connection_id
   AND vouchers.party_id IS NULL
   AND (vouchers.party_name = p.name OR lower(trim(vouchers.party_name)) = lower(trim(p.name)));

-- Backfill voucher_lines.stock_item_id where stock_item_id is null by matching stock_item_name with stock_items.name on connection_id
UPDATE voucher_lines
   SET stock_item_id = s.id
  FROM vouchers v, stock_items s
 WHERE voucher_lines.voucher_id = v.id
   AND s.connection_id = v.connection_id
   AND voucher_lines.stock_item_id IS NULL
   AND (voucher_lines.stock_item_name = s.name OR lower(trim(voucher_lines.stock_item_name)) = lower(trim(s.name)))
   AND voucher_lines.stock_item_name IS NOT NULL
   AND voucher_lines.stock_item_name <> '';
