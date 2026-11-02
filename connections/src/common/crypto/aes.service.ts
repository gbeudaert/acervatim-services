import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ALGO = 'aes-256-gcm';

/**
 * AES-256-GCM des secrets reversibles (jetons de sources externes).
 *
 * `ENCRYPTION_KEY` est **facultative au boot** et obligatoire a l'usage : `CryptoModule` est
 * global et charge dans tous les services, mais seul `connections` chiffre quoi que ce soit.
 * Echouer au demarrage partout pour une cle dont un seul service a besoin transformerait une
 * configuration incomplete en panne generale ; echouer au premier appel la laisse locale et
 * lisible.
 */
@Injectable()
export class AesService implements OnModuleInit {
  private key?: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const raw = this.config.get<string>('ENCRYPTION_KEY');
    if (!raw) return;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_LENGTH) {
      throw new Error(
        `ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${buf.length})`,
      );
    }
    this.key = buf;
  }

  /** Renvoie `base64(iv || authTag || ciphertext)`. */
  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  /** Throw si tampering detecte ou format invalide. */
  decrypt(payload: string): string {
    const key = this.requireKey();
    const buf = Buffer.from(payload, 'base64');
    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('AES payload too short');
    }
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ct = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      'utf8',
    );
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error('ENCRYPTION_KEY must be set to use AesService');
    }
    return this.key;
  }
}
