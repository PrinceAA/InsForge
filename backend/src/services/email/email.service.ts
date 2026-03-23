import { EmailProvider } from '@/providers/email/base.provider.js';
import { CloudEmailProvider } from '@/providers/email/cloud.provider.js';
import { SmtpEmailProvider } from '@/providers/email/smtp.provider.js';
import { SmtpConfigService, RawSmtpConfig } from '@/services/email/smtp-config.service.js';
import { AppError } from '@/api/middlewares/error.js';
import { ERROR_CODES } from '@/types/error-constants.js';
import { EmailTemplate } from '@/types/email.js';
import { SendRawEmailRequest } from '@insforge/shared-schemas';
import logger from '@/utils/logger.js';

/**
 * Email service that orchestrates different email providers
 * Resolves provider per-call so SMTP config changes take effect without restart
 */
export class EmailService {
  private static instance: EmailService;
  private cloudProvider: CloudEmailProvider;
  private smtpProvider: SmtpEmailProvider;
  /** Tracks last email sent time per recipient for minIntervalSeconds enforcement */
  private lastEmailSentAt: Map<string, number> = new Map();

  private constructor() {
    this.cloudProvider = new CloudEmailProvider();
    this.smtpProvider = new SmtpEmailProvider();
    logger.info('EmailService initialized (cloud + SMTP providers available)');
  }

  /**
   * Get singleton instance of EmailService
   */
  public static getInstance(): EmailService {
    if (!EmailService.instance) {
      EmailService.instance = new EmailService();
    }
    return EmailService.instance;
  }

  /**
   * Resolve which provider to use based on current SMTP configuration
   * Checked per-call so config changes take effect without restart
   * Falls back to cloud provider on any error checking SMTP config
   * Returns [provider, smtpConfig | null]
   */
  private async resolveProvider(): Promise<[EmailProvider, RawSmtpConfig | null]> {
    try {
      const smtpConfig = await SmtpConfigService.getInstance().getRawSmtpConfig();
      if (smtpConfig) {
        logger.debug('Using SMTP email provider');
        return [this.smtpProvider, smtpConfig];
      }
    } catch (error) {
      logger.warn('Error checking SMTP config, falling back to cloud provider', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return [this.cloudProvider, null];
  }

  /**
   * Enforce per-recipient minimum interval between emails
   * Throws 429 if the recipient was emailed too recently
   */
  private enforceMinInterval(email: string, minIntervalSeconds: number): void {
    if (minIntervalSeconds <= 0) return;

    const now = Date.now();
    const lastSent = this.lastEmailSentAt.get(email);

    if (lastSent && now - lastSent < minIntervalSeconds * 1000) {
      const retryAfter = Math.ceil((minIntervalSeconds * 1000 - (now - lastSent)) / 1000);
      throw new AppError(
        `Too many emails to this address. Retry after ${retryAfter}s.`,
        429,
        ERROR_CODES.RATE_LIMITED
      );
    }

    this.lastEmailSentAt.set(email, now);

    // Prune stale entries (older than 2x the interval) to prevent memory growth
    if (this.lastEmailSentAt.size > 10000) {
      const cutoff = now - minIntervalSeconds * 2000;
      for (const [key, ts] of this.lastEmailSentAt) {
        if (ts < cutoff) this.lastEmailSentAt.delete(key);
      }
    }
  }

  /**
   * Send email using predefined template
   * @param email - Recipient email address
   * @param name - Recipient name
   * @param template - Template type
   * @param variables - Variables to use in the email template
   */
  public async sendWithTemplate(
    email: string,
    name: string,
    template: EmailTemplate,
    variables?: Record<string, string>
  ): Promise<void> {
    const [provider, smtpConfig] = await this.resolveProvider();

    // Enforce minIntervalSeconds when using custom SMTP
    if (smtpConfig) {
      this.enforceMinInterval(email, smtpConfig.minIntervalSeconds);
    }

    return provider.sendWithTemplate(email, name, template, variables);
  }

  /**
   * Send custom/raw email
   * @param options - Email options (to, subject, html, cc, bcc, from, replyTo)
   */
  public async sendRaw(options: SendRawEmailRequest): Promise<void> {
    const [provider, smtpConfig] = await this.resolveProvider();

    // Enforce minIntervalSeconds when using custom SMTP
    if (smtpConfig) {
      const primaryRecipient = Array.isArray(options.to) ? options.to[0] : options.to;
      if (primaryRecipient) {
        this.enforceMinInterval(primaryRecipient, smtpConfig.minIntervalSeconds);
      }
    }

    if (!provider.sendRaw) {
      throw new Error('Current email provider does not support raw email sending');
    }
    return provider.sendRaw(options);
  }

  /**
   * Check if current provider supports templates
   */
  public supportsTemplates(): boolean {
    // Both providers support templates
    return true;
  }
}
