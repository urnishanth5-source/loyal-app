alter table public.billing_settings
  alter column barcode_label_settings set default
  '{
    "sheetWidthMm": 100,
    "sheetHeightMm": 25,
    "stickersPerSheet": 2,
    "paddingMm": 1.5,
    "barcodeHeightMm": 15,
    "barcodeModuleWidth": 1.4,
    "textSizePt": 8,
    "showBusinessName": true,
    "businessName": "",
    "showBarcodeValue": true,
    "showName": true,
    "showPrice": false,
    "showSku": false,
    "showHsn": false,
    "showBrand": false,
    "showSize": false,
    "customText": ""
  }'::jsonb;

update public.billing_settings
set barcode_label_settings =
  jsonb_set(
    jsonb_set(
      barcode_label_settings,
      '{showBusinessName}',
      'true'::jsonb,
      true
    ),
    '{businessName}',
    to_jsonb(legal_name),
    true
  )
where not (barcode_label_settings ? 'businessName');
