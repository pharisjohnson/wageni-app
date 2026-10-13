"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";

/**
 * Finger/mouse signature on a canvas, exported as a PNG blob. A drawn
 * signature cannot be keyboard operated; the field's help text tells people
 * to ask reception if they cannot sign here.
 */
export function SignaturePad({
  onSave,
  disabled,
  large,
}: {
  onSave: (png: Blob) => void;
  disabled?: boolean;
  large?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
  }, []);

  function point(e: PointerEvent<HTMLCanvasElement>) {
    const c = canvas.current!;
    const rect = c.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * c.width,
      y: ((e.clientY - rect.top) / rect.height) * c.height,
    };
  }

  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
    setInked(true);
  }

  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function clear() {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setInked(false);
  }

  function save() {
    canvas.current?.toBlob((b) => b && onSave(b), "image/png");
  }

  return (
    <div className="space-y-2">
      <canvas
        ref={canvas}
        width={600}
        height={200}
        role="img"
        aria-label="Signature area. Draw your signature with your finger or mouse."
        className="w-full touch-none rounded-lg border bg-white"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      />
      <div className="flex gap-2">
        <Button type="button" variant="outline" size={large ? "lg" : "default"} onClick={clear} disabled={!inked || disabled}>
          Clear
        </Button>
        <Button type="button" size={large ? "lg" : "default"} onClick={save} disabled={!inked || disabled}>
          Use this signature
        </Button>
      </div>
    </div>
  );
}
