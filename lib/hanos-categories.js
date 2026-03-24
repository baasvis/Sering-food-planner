// ─────────────────────────────────────────────────────────────────────────────
// HANOS CATEGORY MAPPING — Maps Hanos product categories to app types/categories
// ─────────────────────────────────────────────────────────────────────────────

const HANOS_TYPE_MAP = {
  // Food
  'Aardappelen en aardappelproducten': { types: ['Food'], category: 'Grains & Starches' },
  'Antipasti en Olijven': { types: ['Food'], category: 'Canned & Preserved' },
  'Bak- en dessertprodukten': { types: ['Food'], category: 'Baking & Dessert' },
  'Brood': { types: ['Food'], category: 'Grains & Starches' },
  'Brood en banket': { types: ['Food'], category: 'Grains & Starches' },
  'Champignons en paddenstoelen': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Chocolade': { types: ['Food'], category: 'Baking & Dessert' },
  'Chocolade en suikerwerk': { types: ['Food'], category: 'Baking & Dessert' },
  'Conserven': { types: ['Food'], category: 'Canned & Preserved' },
  'Fruit': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Groente en fruit': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Groenten': { types: ['Food'], category: 'Vegetables & Fruit' },
  'Grondstoffen en ingrediënten': { types: ['Food'], category: 'Sauces & Condiments' },
  'IJs- en handijs': { types: ['Food'], category: 'Baking & Dessert' },
  'Internationale keuken': { types: ['Food'], category: 'Sauces & Condiments' },
  'Kaas': { types: ['Food'], category: 'Dairy & Alternatives' },
  'Kruiden': { types: ['Food'], category: 'Herbs & Spices' },
  'Kruiden en specerijen': { types: ['Food'], category: 'Herbs & Spices' },
  'Maaltijdversierders': { types: ['Food'], category: 'Herbs & Spices' },
  'Overige diepvriesproducten': { types: ['Food'], category: 'Canned & Preserved' },
  'Rijst en Deegwaren': { types: ['Food'], category: 'Grains & Starches' },
  'Sauzen': { types: ['Food'], category: 'Sauces & Condiments' },
  'Snacks': { types: ['Food'], category: 'Snacks' },
  'Suiker': { types: ['Food'], category: 'Baking & Dessert' },
  "Tapenades en pesto's": { types: ['Food'], category: 'Sauces & Condiments' },
  'Texturas': { types: ['Food'], category: 'Herbs & Spices' },
  'Vetten en olie': { types: ['Food'], category: 'Oils & Fats' },
  'Zeewier en zeewierproducten': { types: ['Food'], category: 'Seaweed & Specialty' },
  'Zuivel': { types: ['Food'], category: 'Dairy & Alternatives' },
  'Zuren en azijn': { types: ['Food'], category: 'Sauces & Condiments' },
  // Drinks
  'Bieren': { types: ['Drinks'], category: 'Beer' },
  'Gedistilleerd': { types: ['Drinks'], category: 'Spirits & Liqueurs' },
  'Koude dranken': { types: ['Drinks'], category: 'Juices & Soft Drinks' },
  'Warme dranken': { types: ['Drinks'], category: 'Coffee & Tea' },
  'Wijn': { types: ['Drinks'], category: 'Wine' },
  // Non-food
  'Aan Tafel': { types: ['FOH Supplies'], category: 'Tableware & FOH' },
  'Bar en buffet': { types: ['FOH Equipment'], category: 'Tableware & FOH' },
  'Barbecues en benodigdheden': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
  'Disposables': { types: ['FOH Supplies'], category: 'Disposables & Packaging' },
  'Kantoor en administratie': { types: ['Office'], category: 'Office & Admin' },
  'Keuken': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
  'Keukenapparatuur': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
  'Kleding en textiel': { types: ['Kitchen Equipment'], category: 'Clothing & Textiles' },
  'Persoonlijke verzorging': { types: ['Cleaning'], category: 'Cleaning & Hygiene' },
  'Schoonmaak en hygiëne': { types: ['Cleaning'], category: 'Cleaning & Hygiene' },
  'Veiligheid': { types: ['Kitchen Equipment'], category: 'Kitchen Equipment' },
};

function mapHanosCategory(hanosCat) {
  return HANOS_TYPE_MAP[hanosCat] || { types: ['Food'], category: '' };
}

module.exports = { HANOS_TYPE_MAP, mapHanosCategory };
