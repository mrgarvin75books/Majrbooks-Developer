/**
 * Rule-based (no AI) first guess at a Schedule C category for a bank line.
 * Anything not recognised is left as "Needs review" so a person decides;
 * those lines are kept out of totals until categorised.
 */
import type { TxType } from "./scheduleC";

export interface Categorized {
  type: TxType;
  category: string;
  notes: string;
}

type Rule = [RegExp, TxType, string, string?];

// Order matters: first match wins.
const OUT_RULES: Rule[] = [
  [/\b(transfer|xfer|trnsfr|to (savings|checking)|online banking transfer|internal transfer)\b/, "transfer", "Transfer between accounts"],
  [/\b(credit card payment|card payment|payment thank you|autopay|amex epayment|chase card|capital one|discover e?payment|citi card)\b/, "transfer", "Transfer between accounts", "Credit card payment"],
  // Bank fees come early so "monthly maintenance fee" isn't read as repairs.
  [/\b(service charge|service fee|monthly fee|maintenance fee|overdraft|nsf|wire fee|bank fee|stripe fee|square fee|paypal fee|merchant fee|processing fee|interest charge|late fee|foreign transaction fee|cash advance fee|annual fee)\b/, "expense", "Bank and merchant fees"],
  [/\b(atm|cash withdrawal|withdrawal at)\b/, "needs_review", "Needs review", "Cash withdrawal: business or personal?"],
  [/\b(amazon(?! web services| payments)|amzn|walmart|wal-mart|target|costco|sam'?s club|best buy|home depot|lowe'?s)\b/, "needs_review", "Needs review", "General retailer: confirm it was a business purchase"],
  // Software before taxes/licenses so "Adobe license" is software.
  [/\b(adobe|microsoft|msft|office 365|google workspace|gsuite|g suite|zoom|slack|dropbox|quickbooks|intuit|xero|github|aws|amazon web services|heroku|shopify|squarespace|wix|godaddy|canva|notion|openai|anthropic|apple\.com|icloud|subscription)\b/, "expense", "Software and subscriptions"],
  [/\b(irs|us treasury|tax pmt|eftps|franchise tax|dept of revenue|department of revenue|dmv|license|permit|registration)\b/, "expense", "Taxes and licenses"],
  [/\b(gusto|adp|paychex|payroll|salary|wages)\b/, "expense", "Wages"],
  [/\b(google ads|adwords|facebook|meta ads|fb ads|instagram|linkedin ads|yelp|bing ads|tiktok ads|mailchimp|constant contact|vistaprint)\b/, "expense", "Advertising"],
  [/\b(staples|office depot|officemax|office max)\b/, "expense", "Office expense"],
  [/\b(usps|ups|fedex|dhl|stamps\.com|pirate ship|shipstation)\b/, "expense", "Postage and shipping"],
  [/\b(at&t|att|verizon|t-mobile|tmobile|sprint|comcast|xfinity|spectrum|cox comm|frontier(?! air)|centurylink|google fi)\b/, "expense", "Telephone and internet"],
  [/\b(electric|power co|energy|pg&e|duke energy|con ed|water|sewer|utility|utilities|natural gas|waste management)\b/, "expense", "Utilities"],
  [/\b(geico|state farm|progressive|allstate|nationwide|liberty mutual|hartford|insurance|insur)\b/, "expense", "Insurance (other than health)"],
  [/\b(attorney|law office|legal|cpa|accounting|bookkeep|tax prep)\b/, "expense", "Legal and professional services"],
  // Meals before travel ("Uber Eats"), travel before rent ("Enterprise Rent-A-Car").
  [/\b(restaurant|cafe|coffee|starbucks|dunkin|mcdonald|chipotle|subway|panera|doordash|grubhub|uber eats|ubereats|postmates|pizza|grill|diner|bistro|bar & grill)\b/, "expense", "Meals"],
  [/\b(delta|united airlines|american airlines|southwest|jetblue|alaska air|spirit air\w*|frontier airlines|airline|airbnb|marriott|hilton|hyatt|holiday inn|hotel|expedia|booking\.com|hertz|enterprise rent|rent-a-car|avis|uber|lyft)\b/, "expense", "Travel"],
  [/\b(rent|lease|landlord|property mgmt|wework|regus)\b/, "expense", "Rent or lease: business property"],
  [/\b(shell|chevron|exxon|mobil|bp|texaco|sunoco|valero|marathon|speedway|circle k|wawa|fuel|gas station|parking|toll|ez ?pass|car wash|jiffy lube|autozone|o'?reilly auto)\b/, "expense", "Car and truck expenses"],
  [/\b(udemy|coursera|seminar|conference|webinar|training|course)\b/, "expense", "Education and training"],
  [/\b(repair|maintenance|plumb|hvac|handyman)\b/, "expense", "Repairs and maintenance"],
  [/\b(upwork|fiverr|contractor|freelanc)\b/, "expense", "Contract labor"],
];

const IN_RULES: Rule[] = [
  [/\b(refund|return|reversal|chargeback)\b/, "needs_review", "Needs review", "Refund: reduce the original expense or record as income?"],
  [/\b(loan|sba|line of credit|advance)\b/, "needs_review", "Needs review", "Possible loan proceeds (not income)"],
  // Payment-processor payouts are sales even when the bank calls them a "transfer".
  [/\b(stripe|square|sq \*|paypal|shopify|etsy|ebay|amazon payments|clover|toast payout)\b/, "income", "Sales / gross receipts", "Payout from payment processor"],
  [/\b(transfer|xfer|trnsfr|from (savings|checking)|online banking transfer|internal transfer)\b/, "transfer", "Transfer between accounts"],
  [/\binterest\b/, "income", "Other business income", "Interest"],
  [/\b(venmo|zelle|client|invoice|deposit|ach credit|mobile deposit|remote deposit|payment from)\b/, "income", "Sales / gross receipts"],
];

export function categorize(description: string, direction: "in" | "out"): Categorized {
  const d = ` ${description.toLowerCase()} `;
  for (const [re, type, category, notes] of direction === "out" ? OUT_RULES : IN_RULES) {
    if (re.test(d)) return { type, category, notes: notes ?? "" };
  }
  return direction === "in"
    ? { type: "needs_review", category: "Needs review", notes: "Money in: confirm it's business income" }
    : { type: "needs_review", category: "Needs review", notes: "" };
}
