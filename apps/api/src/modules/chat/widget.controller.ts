import { Controller, Get, Query, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import {
  WIDGET_FRAME_JS,
  WIDGET_LOADER_JS,
  frameAncestorsDirective,
  frameCsp,
  widgetFrameHtml,
} from '@moka/chat';
import { Public } from '../../common/decorators.js';
import { VisitorService } from './visitor.service.js';

/**
 * Static widget assets (§22).
 *
 * Three responses, each with headers that are load-bearing rather than
 * decorative:
 *
 *   moka-chat.js  the loader, embedded on the customer's site
 *   frame         the chat document, rendered on OUR origin
 *   frame.js      its script, so the frame's CSP can be `script-src 'self'`
 *
 * The whole reason the chat UI lives in a cross-origin iframe is that model
 * output — influenced by documents we did not write — must never be rendered
 * inside a customer's own origin. See the header of @moka/chat widget.ts.
 */
@Public()
@Controller('public/widget/v1')
export class WidgetController {
  constructor(private readonly visitors: VisitorService) {}

  /**
   * The loader.
   *
   * `Cross-Origin-Resource-Policy: cross-origin` is REQUIRED here and easy to
   * miss: helmet sets `same-origin` by default across the API, which would
   * make every customer's browser refuse to load this script with no visible
   * error beyond a console warning. It is safe to relax on this route because
   * the response is a fixed asset containing no tenant data — the same bytes
   * for every caller.
   */
  @Get('moka-chat.js')
  loader(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff');
    return WIDGET_LOADER_JS;
  }

  @Get('frame.js')
  frameScript(@Res({ passthrough: true }) reply: FastifyReply): string {
    void reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff');
    return WIDGET_FRAME_JS;
  }

  /**
   * The chat document.
   *
   * THIS IS WHERE THE ORIGIN ALLOWLIST BECOMES A REAL CONTROL.
   *
   * Everywhere else the allowlist is advisory — the Origin header can be set
   * to anything by a non-browser client. Here it is compiled into
   * `frame-ancestors`, which the VISITOR'S OWN BROWSER enforces. A site that
   * is not on the list cannot frame this document, and an attacker cannot
   * forge their way past it because the browser doing the enforcing is not
   * theirs. It is the strongest thing the list does.
   *
   * The document is served for an unknown or revoked key too, showing an
   * inert error page under `frame-ancestors 'none'`. Refusing to respond at
   * all would leak, through the difference between a 404 and a 200, which
   * keys are real.
   */
  @Get('frame')
  async frame(
    @Query('k') publicKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const nonce = randomBytes(16).toString('base64');
    let ancestors = "frame-ancestors 'none'";

    if (publicKey) {
      try {
        const deployment = await this.visitors.resolveDeployment(publicKey);
        ancestors = frameAncestorsDirective(deployment.allowedOrigins);
      } catch {
        // Unknown, malformed or revoked. The document still renders, framed
        // by nobody, and the frame's own API calls will fail identically.
        ancestors = "frame-ancestors 'none'";
      }
    }

    void reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', `${frameCsp(nonce)}; ${ancestors}`)
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      // Never cached: the CSP carries a per-response nonce and a
      // per-deployment ancestor list, and a shared cache serving one
      // deployment's policy to another would be a real hole.
      .header('cache-control', 'no-store');

    return widgetFrameHtml({ styleNonce: nonce, scriptPath: '/public/widget/v1/frame.js' });
  }
}
