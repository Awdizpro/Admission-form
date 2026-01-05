// src/components/SignaturePad.jsx
import { useRef, useEffect, useState } from "react";

export default function SignaturePad({ value = "", onChange, height = 160 }) {
  const canvasRef = useRef(null);
  const drewRef = useRef(false);
  const [saved, setSaved] = useState(
    typeof value === "string" && value.startsWith("data:image")
  );

  // ---------- helpers ----------
  const setupCanvas = (canvas, ctx, cssW, cssH) => {
    const dpr = window.devicePixelRatio || 1;

    // backstore size (DPR-scaled) + visual size (fixed px)
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // solid white bg (avoid transparent PNG)
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cssW, cssH);

    // stroke defaults
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
  };

  // ---------- mount / listeners ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    // fix visual size once (prevents shrink/expand)
    const cssW = canvas.clientWidth || 600;
    const cssH = height;
    setupCanvas(canvas, ctx, cssW, cssH);

    // preload existing signature (if any)
    if (value && value.startsWith("data:image")) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, cssW, cssH);
        drewRef.current = true;
        setSaved(true);
      };
      img.src = value;
    }

    let drawing = false;
    const getPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e) => {
      drawing = true;
      const { x, y } = getPos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      e.preventDefault();
    };
    const move = (e) => {
      if (!drawing) return;
      const { x, y } = getPos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
      drewRef.current = true;
      e.preventDefault();
    };
    const up = () => {
      if (!drawing) return;
      drawing = false;
      if (drewRef.current) {
        onChange?.(canvas.toDataURL("image/png"));
        setSaved(true); // we keep a fixed status slot so no layout shift
      }
    };
    const cancel = () => (drawing = false);

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);

    // keep drawing on width changes without changing height
    const handleResize = () => {
      const data = canvas.toDataURL("image/png");
      setupCanvas(canvas, ctx, canvas.clientWidth || 600, cssH);
      if (data.startsWith("data:image")) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, canvas.clientWidth || 600, cssH);
        img.src = data;
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("resize", handleResize);
    };
  }, [height, onChange, value]);

  const clear = () => {
    const c = canvasRef.current;
    const ctx = c.getContext("2d");
    setupCanvas(c, ctx, c.clientWidth || 600, height);
    drewRef.current = false;
    setSaved(false);
    onChange?.("");
  };

  // ===== render =====
  return (
    <div
      // isolate layout so siblings (like text inputs) cannot change this block
      className="border rounded bg-white overflow-hidden select-none"
      style={{
        // total fixed height = canvas (height) + footer (24px)
        height: height + 24,
        contain: "layout paint size",
        isolation: "isolate",
      }}
    >
      <canvas
        ref={canvasRef}
        className="block w-full"
        style={{
          height,               // fixed visual height in px
          touchAction: "none",  // disable touch scroll on canvas
          userSelect: "none",
        }}
        aria-label="Signature pad"
        draggable={false}
      />
      {/* Fixed-height footer -> no reflow when status text toggles */}
      <div className="flex items-center justify-between px-2" style={{ height: 24 }}>
        <button type="button" onClick={clear} className="text-xs underline">
          Clear
        </button>

      </div>
    </div>
  );
}
