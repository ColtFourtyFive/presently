export const interactionChannels = ['Phone', 'Email', 'Meeting', 'Other'] as const;
export type InteractionChannel = typeof interactionChannels[number];
export type InteractionInput = { interactionId: string; channel: InteractionChannel; summary: string };
export type Interaction = { id: string; studentId: string; channel: InteractionChannel; summary: string; actorId: string; actorName: string; occurredAt: string };
export type InteractionResult = { interaction: Interaction; replayed: boolean };
export type InteractionPage = { items: Interaction[]; next: string | null };
