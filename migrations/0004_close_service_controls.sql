-- Preserve migration history while making the fully migrated predeployment
-- database fail closed. Applying this migration does not authorize remote use.

UPDATE service_controls
SET new_sales_enabled = 0,
    callback_delivery_enabled = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;
