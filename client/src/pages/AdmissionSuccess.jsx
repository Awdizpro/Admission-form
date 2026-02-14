

// src/pages/AdmissionSuccess.jsx
import { useLocation, Link } from "react-router-dom";

export default function AdmissionSuccess() {
  const { state } = useLocation();
  const pdfUrl = state?.pdfUrl;

  return (
    <div className="max-w-2xl mx-auto p-6 text-center bg-white rounded">
      <img
        src="https://res.cloudinary.com/www-awdiz-co-in/image/upload/v1768892280/awdiz-logo.svg"
        alt="AWDIZ Logo"
        className="mx-auto w-36 mb-4"
      />
      <h2 className="text-2xl font-semibold mb-2">✅ Your application has been successfully received and shared with our admissions team for review.</h2>
      <p className="mb-4">After the review is completed, we will update you with the next steps.</p>
      {/* {pdfUrl && (
        <a className="inline-block text-white bg-black px-4 py-2 rounded" href={pdfUrl} target="_blank" rel="noreferrer">
          Download PDF
        </a>
      )} */}
    </div>
  );
}
