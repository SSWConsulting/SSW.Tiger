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
    <div
      className={`dropzone ${dragging ? "dropzone--active" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
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
      <div className="file-icon" aria-hidden="true">VTT</div>
      {file ? (
        <>
          <strong>{file.name}</strong>
          <span>{(file.size / 1024).toFixed(1)} KB</span>
          <button className="link-button" type="button" disabled={disabled} onClick={() => input.current?.click()}>
            Choose another file
          </button>
        </>
      ) : (
        <>
          <strong>Drop your transcript here</strong>
          <span>WebVTT (.vtt), up to 10 MB</span>
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => input.current?.click()}>
            Choose file
          </button>
        </>
      )}
    </div>
  );
}
