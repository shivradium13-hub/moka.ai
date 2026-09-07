/**
 * The payment gateway boundary (master prompt §34, §45; architecture §2).
 *
 * REAL MONEY MOVEMENT IS NOT IMPLEMENTED, AND NOTHING HERE PRETENDS IT IS.
 *
 * §45 is unambiguous: never create a fake payment confirmation. A method that
 * returned `{ status: 'paid' }` without a processor having taken money would
 * be the most damaging possible instance of that — an organization would be
 * granted a paid plan, the credits would be real, the provider calls would be
 * real, and the money would not exist.
 *
 * So there is no Stripe adapter here, and the interface below has exactly two
 * implementations:
 *
 *   ManualPaymentGateway   An operator records that payment was arranged
 *                          outside the system. Genuinely useful — invoice
 *                          billing and self-hosted deployments are how most
 *                          of this product's likely customers would pay — and
 *                          honest, because a human asserted the fact rather
 *                          than the code inventing it.
 *
 *   UnavailablePaymentGateway  Refuses, and says why. The default, so a
 *                          deployment that has configured no processor cannot
 *                          accidentally appear to accept card payments.
 *
 * A processor is a per-transaction fee rather than a SaaS subscription, so it
 * is not a licensing problem — it is simply not built. The entitlement and
 * credit ledger is entirely ours and does not depend on one, which is why
 * Phases 1–8 never needed this file.
 */

export const CheckoutStatus = {
  /** A human recorded that payment was arranged elsewhere. */
  RECORDED_MANUALLY: 'recorded_manually',
  /** No processor is configured. Nothing was charged. */
  UNAVAILABLE: 'unavailable',
} as const;

export type CheckoutStatus = (typeof CheckoutStatus)[keyof typeof CheckoutStatus];

export interface CheckoutRequest {
  readonly organizationId: string;
  readonly planKey: string;
  /** Who is asserting this. Recorded, so a manual entry is attributable. */
  readonly actorUserId: string | null;
  /** An invoice number, a contract reference — whatever the operator has. */
  readonly externalReference?: string | null;
  readonly note?: string | null;
}

export interface CheckoutResult {
  readonly status: CheckoutStatus;
  /** True only when the subscription may actually be activated. */
  readonly activate: boolean;
  /** Shown to the user. Never implies money moved unless it did. */
  readonly message: string;
  readonly externalReference: string | null;
}

export interface PaymentGateway {
  readonly id: string;
  /**
   * Whether this gateway can move money. FALSE for both implementations here,
   * and the property exists so a UI can say "invoice only" rather than
   * rendering a card form that leads nowhere.
   */
  readonly canChargeCards: boolean;
  checkout(request: CheckoutRequest): Promise<CheckoutResult>;
}

/**
 * Records that payment was arranged outside this system.
 *
 * The subscription IS activated, because a person with the authority to do so
 * has asserted that the customer paid. That is a different thing from the
 * software claiming it: the assertion is attributable to a user id, carries a
 * reference, and is written to the audit log.
 */
export class ManualPaymentGateway implements PaymentGateway {
  readonly id = 'manual';
  readonly canChargeCards = false;

  async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
    return {
      status: CheckoutStatus.RECORDED_MANUALLY,
      activate: true,
      // Precise about what happened. "Payment successful" would be a claim
      // about a transaction this system did not observe.
      message:
        'Recorded as arranged outside this system. No payment was taken here — ' +
        'the subscription is active because an administrator said it should be.',
      externalReference: request.externalReference ?? null,
    };
  }
}

/**
 * The default. Refuses, and explains.
 *
 * Deliberately NOT a silent success or a queued job that never completes. A
 * deployment with no processor configured must fail visibly at the moment
 * someone tries to buy something, not appear to work and leave an
 * organization on a plan it never paid for.
 */
export class UnavailablePaymentGateway implements PaymentGateway {
  readonly id = 'unavailable';
  readonly canChargeCards = false;

  async checkout(_request: CheckoutRequest): Promise<CheckoutResult> {
    return {
      status: CheckoutStatus.UNAVAILABLE,
      activate: false,
      message:
        'Online payment is not configured for this deployment. No card processor is ' +
        'integrated, and nothing was charged. An administrator can record a plan change ' +
        'directly if payment has been arranged another way.',
      externalReference: null,
    };
  }
}

/**
 * TODO(Phase 10): a real processor adapter, if this is ever hosted commercially.
 *
 * When one is written, three things must hold and none of them is optional:
 *
 *  1. A subscription is activated by a verified WEBHOOK from the processor,
 *     never by the browser returning from a checkout page. A redirect is a
 *     claim from an untrusted client; a signed webhook is evidence.
 *  2. The webhook signature is verified before the body is parsed, and the
 *     event id is recorded so a replayed event cannot grant a second month.
 *  3. Card data never reaches this server. Hosted checkout only, so the PCI
 *     surface stays with the processor.
 *
 * Written here rather than in a ticket because the person implementing it will
 * read this file first, and the redirect-versus-webhook mistake is the one
 * that gets made.
 */
