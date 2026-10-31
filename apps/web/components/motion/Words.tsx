/**
 * A line of text whose words rise in one after another. `start` continues the count from an
 * earlier <Words> in the same heading, so a sentence split across elements still flows in order.
 * Screen readers get the plain sentence.
 */
export function Words({ text, start = 0 }: { text: string; start?: number }) {
  const words = text.split(" ");
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((w, i) => (
          <span key={i} className="word" style={{ "--w": start + i } as React.CSSProperties}>
            {w}
            {i < words.length - 1 ? " " : ""}
          </span>
        ))}
      </span>
    </>
  );
}

export const wordCount = (text: string) => text.split(" ").length;
