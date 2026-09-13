/**
 * The tag as the model wrote it. Both card kinds show this when their deployment switch
 * is off — the message keeps the literal text rather than losing the model's output.
 */
export function CardTagText({ raw }: { raw: string }) {
  return <span className="block whitespace-pre-wrap break-words">{raw}</span>;
}
