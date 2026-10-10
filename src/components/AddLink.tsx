/**
 * "+ Add" beside a section's heading, for a new tracker in that section. In the heading row, not among the tiles,
 * so it isn't tapped by mistake while logging.
 */
export function AddLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="add-link" aria-label={label} onClick={onClick}>
      + Add
    </button>
  );
}
