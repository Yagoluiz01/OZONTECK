const PUBLIC_CATALOG_PRODUCT_FIELDS = Object.freeze([
  "id",
  "sku",
  "slug",
  "name",
  "category_id",
  "category",
  "shortDescription",
  "imageUrl",
  "image_thumb_url",
  "image_detail_url",
  "image_srcset_thumb",
  "image_lqip",
  "price",
  "compareAtPrice",
  "stockQuantity",
  "status",
  "installment_count",
  "installment_value",
  "installment_label",
  "payment_method_simulated",
  "payment_fee_value",
  "payment_net_value",
  "variant_group",
  "variant_type",
  "variant_label",
  "variant_order",
  "pricing_updated_at",
]);

function compactPublicProductForCatalog(product = {}) {
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    category_id: product.category_id || product.categoryId || "",
    category: product.category || "",
    shortDescription: product.shortDescription || product.description || "",
    imageUrl: product.imageUrl || "",
    image_thumb_url:
      product.image_thumb_url || product.imageThumbUrl || product.imageUrl || "",
    image_detail_url:
      product.image_detail_url || product.imageDetailUrl || product.imageUrl || "",
    image_srcset_thumb:
      product.image_srcset_thumb || product.imageSrcsetThumb || "",
    image_lqip: product.image_lqip || product.imageLqip || "",
    price: Number(product.price || 0),
    compareAtPrice: Number(
      product.compareAtPrice ?? product.compare_at_price ?? 0,
    ),
    stockQuantity: Number(product.stockQuantity ?? product.stock_quantity ?? 0),
    status: String(product.status || "").trim().toLowerCase(),
    installment_count: Number(
      product.installment_count ?? product.installmentCount ?? 0,
    ),
    installment_value:
      product.installment_value ?? product.installmentValue ?? null,
    installment_label:
      product.installment_label || product.installmentLabel || "",
    payment_method_simulated:
      product.payment_method_simulated ||
      product.paymentMethodSimulated ||
      "credit_card",
    payment_fee_value:
      product.payment_fee_value ?? product.paymentFeeValue ?? null,
    payment_net_value:
      product.payment_net_value ?? product.paymentNetValue ?? null,
    variant_group: product.variant_group || product.variantGroup || "",
    variant_type: product.variant_type || product.variantType || "",
    variant_label: product.variant_label || product.variantLabel || "",
    variant_order: Number(product.variant_order ?? product.variantOrder ?? 0),
    pricing_updated_at:
      product.pricing_updated_at || product.pricingUpdatedAt || null,
  };
}

function compactPublicProductsForCatalog(products = []) {
  if (!Array.isArray(products)) return [];
  return products.map(compactPublicProductForCatalog);
}

function buildPublicCatalogPayload(products = []) {
  return JSON.stringify({
    success: true,
    products,
  });
}

export {
  PUBLIC_CATALOG_PRODUCT_FIELDS,
  buildPublicCatalogPayload,
  compactPublicProductForCatalog,
  compactPublicProductsForCatalog,
};
