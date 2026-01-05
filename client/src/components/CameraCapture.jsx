import { useEffect, useRef, useState } from "react";

export default function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const [stream, setStream] = useState(null);

  useEffect(() => {
    async function startCamera() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        setStream(s);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      } catch (err) {
        alert("Unable to access camera. Please allow camera permission.");
        onClose?.();
      }
    }
    startCamera();

    return () => {
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, []);

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    onCapture(dataUrl);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-white p-4 rounded-lg shadow-lg w-[90%] sm:w-[400px] text-center space-y-3">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="w-full rounded border"
        />
        <div className="flex justify-center gap-4">
          <button
            onClick={capturePhoto}
            className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded"
          >
            Capture
          </button>
          <button
            onClick={onClose}
            className="bg-gray-300 hover:bg-gray-400 text-black px-4 py-2 rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
