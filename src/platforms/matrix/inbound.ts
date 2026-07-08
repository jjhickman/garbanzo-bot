import type { InboundMessage } from '../../core/inbound-message.js';
import type { MessageRef } from '../../core/message-ref.js';

export interface MatrixInbound extends InboundMessage {
  platform: 'matrix';
  raw: MessageRef;
}
