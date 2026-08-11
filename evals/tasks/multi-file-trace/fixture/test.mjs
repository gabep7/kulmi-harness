import assert from "node:assert/strict";
import { checkout } from "./checkout.mjs";

// 3 x 40.00 = 120.00 subtotal, which is in the 5% tier.
// 120.00 - 6.00 = 114.00, plus 21% tax = 137.94
assert.equal(checkout([{ price: 40, quantity: 3 }]), 137.94);

// 2 x 300.00 = 600.00 subtotal, which is in the 10% tier.
// 600.00 - 60.00 = 540.00, plus 21% tax = 653.40
assert.equal(checkout([{ price: 300, quantity: 2 }]), 653.4);

// Below the first paid tier: 50.00 plus 21% tax = 60.50
assert.equal(checkout([{ price: 50, quantity: 1 }]), 60.5);
console.log("ok");
