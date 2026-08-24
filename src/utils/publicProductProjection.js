const PUBLIC_PRODUCT_SELECT_FIELDS = Object.freeze([
  "id",
  "sku",
  "name",
  "category_id",
  "category",
  "short_description",
  "image_url",
  "image_url_2",
  "image_thumb_url",
  "image_card_url",
  "image_detail_url",
  "image_zoom_url",
  "image_lqip",
  "image_2_thumb_url",
  "image_2_card_url",
  "image_2_detail_url",
  "image_2_zoom_url",
  "image_2_lqip",
  "video_url",
  "video_poster_url",
  "price",
  "compare_at_price",
  "stock_quantity",
  "status",
  "show_on_home",
  "variant_group",
  "variant_type",
  "variant_label",
  "variant_order",
  "weight_kg",
  "height_cm",
  "width_cm",
  "length_cm",
  "installment_count",
  "installment_value",
  "installment_label",
  "payment_method_simulated",
  "payment_fee_value",
  "payment_net_value",
  "home_order",
  "created_at",
  "updated_at",
  "real_margin_percent",
  "pricing_updated_at",
]);

const PUBLIC_PRODUCT_SELECT = PUBLIC_PRODUCT_SELECT_FIELDS.join(",");

function buildPublicProductsUrl(supabaseUrl) {
  const baseUrl = String(supabaseUrl || "").trim().replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/rest/v1/products`);

  url.searchParams.set("select", PUBLIC_PRODUCT_SELECT);

  return url.toString();
}

export {
  PUBLIC_PRODUCT_SELECT,
  PUBLIC_PRODUCT_SELECT_FIELDS,
  buildPublicProductsUrl,
};
