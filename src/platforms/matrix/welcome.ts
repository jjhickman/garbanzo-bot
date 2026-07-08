import { getMatrixRoomName } from './matrix-config.js';

interface BuildMatrixWelcomeMessageInput {
  roomId: string;
  memberUserId: string;
  memberDisplayName?: string;
}

export function buildMatrixWelcomeMessage(input: BuildMatrixWelcomeMessageInput): string {
  const roomName = getMatrixRoomName(input.roomId);
  const destination = roomName ?? 'the room';
  const who = input.memberDisplayName ?? input.memberUserId;

  return `Welcome ${who} to ${destination}! Glad you're here - jump in when you're ready.`;
}
