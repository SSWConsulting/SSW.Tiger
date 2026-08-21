import { useRef, useState, type DragEvent } from "react";

type Props = {
  file: File | null;
  disabled?: boolean;
  onSelect: (file: File | null) => void;
};

export function TranscriptDropzone({ file, disabled, onSelect }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const acceptDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) onSelect(event.dataTransfer.files.item(0));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is a progressive enhancement; the accessible control is the labelled <input> and "Choose file" button inside.
    <div
      className={`flex min-h-[148px] flex-col items-center justify-center gap-2 rounded-ds border border-dashed p-6 text-center transition ${
        dragging ? "border-primary bg-ssw-red-50" : "border-black/25 bg-ssw-gray-50"
      }`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragging(false)}
      onDrop={acceptDrop}
    >
      <input
        ref={input}
        className="sr-only"
        type="file"
        accept=".vtt,text/vtt"
        disabled={disabled}
        onChange={(event) => onSelect(event.target.files?.[0] || null)}
        aria-label="Choose transcript file"
      />
      <div
        className="mb-2 grid h-[58px] w-12 place-items-center rounded-ds-sm bg-secondary text-[11px] font-bold tracking-widest text-white"
        aria-hidden="true"
      >
        VTT
      </div>
      {file ? (
        <>
          <strong className="text-ssw-charcoal">{file.name}</strong>
          <span className="text-[13px] text-black/60">{(file.size / 1024).toFixed(1)} KB</span>
          <button
            className="border-0 bg-transparent font-semibold text-primary underline disabled:opacity-60"
            type="button"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            Choose another file
          </button>
        </>
      ) : (
        <>
          <strong className="text-ssw-charcoal">Drop your transcript here</strong>
          <span className="text-[13px] text-black/60">WebVTT (.vtt), up to 10 MB</span>
          <button
            className="mt-1 rounded-ds-sm border border-black/10 bg-transparent px-4 py-2 font-medium text-ssw-charcoal transition hover:bg-black/5 disabled:opacity-60"
            type="button"
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            Choose file
          </button>
        </>
      )}
    </div>
  );
}
