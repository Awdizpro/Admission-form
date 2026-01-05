

// src/pages/AdmissionSuccess.jsx
import { useLocation, Link } from "react-router-dom";

export default function AdmissionSuccess() {
  const { state } = useLocation();
  const pdfUrl = state?.pdfUrl;

  return (
    <div className="max-w-2xl mx-auto p-6 text-center bg-white rounded">
      <img
        src="https://res.cloudinary.com/www-awdiz-in/image/upload/v1675932002/logo/awdiz.png"
        alt="AWDIZ Logo"
        className="mx-auto w-36 mb-4"
      />
      <h2 className="text-2xl font-semibold mb-2">✅ Your admission form has been successfully submitted.</h2>
      <p className="mb-4">We’ve sent your Admission Pending copy to your registered email. Our team will verify your details and approve your admission soon.</p>
      {pdfUrl && (
        <a className="inline-block text-white bg-black px-4 py-2 rounded" href={pdfUrl} target="_blank" rel="noreferrer">
          Download PDF
        </a>
      )}
    </div>
  );
}
