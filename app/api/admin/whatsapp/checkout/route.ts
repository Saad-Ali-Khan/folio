import { submitCodCheckout } from "@/lib/cod-checkout";

export function POST(request: Request) {
  return submitCodCheckout(request, true);
}
