import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';

/**
 * HMAC-SHA-256 hexadecimal. Unique primitive de hachage de la constellation : elle sert
 * au pivot d'identite (`identity`, pepper SUB_HASH_PEPPER), aux codes d'invitation
 * (`billing`, INVITE_CODE_PEPPER) et aux codes de partage (`sharing`, SHARE_CODE_PEPPER).
 *
 * Trois peppers distincts pour trois surfaces d'exposition et trois cadences de rotation
 * differentes - un seul pepper partage ferait qu'une rotation en imposerait trois.
 */
@Injectable()
export class HashService {
  hmacSha256Hex(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value).digest('hex');
  }
}
