alter table public.billing_settings
  add column if not exists barcode_label_settings jsonb not null default
  '{
    "sheetWidthMm": 100,
    "sheetHeightMm": 25,
    "stickersPerSheet": 2,
    "paddingMm": 1.5,
    "barcodeHeightMm": 15,
    "barcodeModuleWidth": 1.4,
    "textSizePt": 8,
    "showBarcodeValue": true,
    "showName": true,
    "showPrice": false,
    "showSku": false,
    "showHsn": false,
    "showBrand": false,
    "showSize": false,
    "customText": ""
  }'::jsonb;

alter table public.billing_settings
  drop constraint if exists billing_settings_barcode_label_settings_check;

alter table public.billing_settings
  add constraint billing_settings_barcode_label_settings_check
  check (jsonb_typeof(barcode_label_settings) = 'object');
