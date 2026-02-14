// server/src/models/Admission.js
import mongoose from "mongoose";

/** One education row (PDF table: Qualification | School/College | Year | % Marks) */
const EducationSchema = new mongoose.Schema(
  {
    qualification: { type: String, trim: true, default: "" },
    school:       { type: String, trim: true, default: "" }, // <-- needed by form/PDF
    year:         { type: String, trim: true, default: "" },
    percentage:   { type: String, trim: true, default: "" },
  },
  { _id: false }
);

/** Optional staff signature blocks */
const StaffSignSchema = new mongoose.Schema(
  {
    fullName:   { type: String, trim: true, default: "" },
    signUrl:    { type: String, trim: true, default: "" },
    // ✅ optional: allow data URL too (helps PDF service if not uploaded)
    signDataUrl:{ type: String, trim: true, default: "" },
  },
  { _id: false }
);

const AdmissionSchema = new mongoose.Schema(
  {
    /* ======= STATUS (for approval flow) ======= */
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending"
    },

    /* ======= PAGE / HEADER ======= */
    effectiveDate: Date, // optional, print if you want in PDF header
    center: {
      placeOfAdmission: { type: String, trim: true, default: "" },
      mode:             { type: String, trim: true, default: "" }, // "Online" | "Offline" | "Hybrid"
    },

    /* ======= CANDIDATE ======= */
    personal: {
      salutation:           { type: String, trim: true, default: "Mr" }, // Mr/Ms/Mrs
      name:                 { type: String, trim: true, required: true },
      fatherOrGuardianName: { type: String, trim: true, default: "" },
      address:              { type: String, trim: true, default: "" },
      parentMobile:         { type: String, trim: true, default: "" },
      studentMobile:        { type: String, trim: true, required: true },
      whatsappMobile:       { type: String, trim: true, default: "" },
      email:                { type: String, trim: true, required: true },
    },

    /* ======= COURSE ======= */
    course: {
      name:      { type: String, trim: true, required: true },
      enrolled:  { type: Boolean, required: true, default: true },
      reference: { type: String, trim: true, default: "" },

      // added for your Job Guarantee vs Training-only flow
      trainingOnly:       { type: Boolean, default: false },
      trainingOnlyCourse: { type: String, trim: true, default: "" },
    },

    /* ======= EDUCATION TABLE ======= */
    education: { type: [EducationSchema], default: [] },

    /* ======= IDS ======= */
    ids: {
      pan:               { type: String, trim: true, default: "" },
      aadhaarOrDriving:  { type: String, trim: true, default: "" },
    },

    /* ======= UPLOADS (URLs + inline data-urls) ======= */
    uploads: {
      // final uploaded URLs
      photoUrl:   { type: String, trim: true, default: "" },
      panUrl:     { type: String, trim: true, default: "" },
      aadhaarUrl: { type: String, trim: true, default: "" },

      // ✅ inline data URLs kept for PDF generation on approval
      photoDataUrl:   { type: String, trim: true, default: "" },
      panDataUrl:     { type: String, trim: true, default: "" },
      aadhaarDataUrl: { type: String, trim: true, default: "" },
    },

    /* ======= SIGNATURES ======= */
    signatures: {
      student: {
        fullName:   { type: String, trim: true, default: "" },
        signUrl:    { type: String, trim: true, default: "" }, // final uploaded URL
        // ✅ also preserve data URL if captured
        signDataUrl:{ type: String, trim: true, default: "" },
      },
      parent: {
        fullName:   { type: String, trim: true, default: "" },
        signUrl:    { type: String, trim: true, default: "" },
        signDataUrl:{ type: String, trim: true, default: "" },
      },
      centerManager: { type: StaffSignSchema, default: () => ({}) },
      counselor:     { type: StaffSignSchema, default: () => ({}) },
    },

    /* ======= TERMS ======= */
    tc: {
      accepted: { type: Boolean, required: true }, // checkbox
      version:  { type: String, trim: true, default: "v1" },
      text:     { type: String, default: "" }, // full T&C to print in PDF
      type: {
        type: String,
        enum: ["job-guarantee", "training-only"],
        default: function () {
          return this?.course?.trainingOnly ? "training-only" : "job-guarantee";
        },
      },
    },

    /* ======= META (for Google Sheets or tracking) ======= */
    meta: {
      planType: {
        type: String,
        enum: ["job", "training"],
        default: function () {
          return this?.course?.trainingOnly ? "training" : "job";         
        },       
      },
      counselorKey: { type: String, trim: true, default: "" }, // ✅ NEW
    },

    /* ======= PDF refs (Pending + Approved) ======= */
    pdf: {
      pendingStudentUrl:   { type: String, trim: true, default: "" },
      pendingCounselorUrl: { type: String, trim: true, default: "" },
      approvedUrl:         { type: String, trim: true, default: "" },
    },

    // (keep your legacy URLs for backward compatibility)
    pdfUrl:      { type: String, trim: true, default: "" },
    pdfPublicId: { type: String, trim: true, default: "" },

    /* ======= EDIT REQUEST (counselor → student) ======= */
    editRequest: {
      sections:  { type: [String], default: [] },  // e.g. ["personal","course","fees"]
      fields:    { type: [String], default: [] }, // 👈 NEW
      notes:     { type: String, trim: true, default: "" }, // counselor comments
      token:     { type: String, trim: true, default: "" }, // secure edit link token
      status:    { type: String, trim: true, default: "" }, // "", "pending", "completed"
      createdAt: { type: Date },
      resolvedAt:{ type: Date },
    },
    // ✅ NEW: Counselor → Admin submission + Fees info (DON'T REMOVE ANYTHING ELSE)
fees: {
  amount: { type: Number, default: 0 }, // counselor input (required on submit)
  paymentMode: {
    type: String,
    enum: ["cash", "online", "instalment", "bajaj_emi", ""],
    default: "",
  },
  // ✅ NEW: Instalment/Bajaj EMI fields
  totalFees: { type: Number, default: 0 }, // Total course fees
  pendingFees: { type: Number, default: 0 }, // Calculated pending fees
  instalmentPlan: { type: String, default: "" }, // "instalment_1", "instalment_2", "instalment_3"
  instalmentCount: { type: Number, default: 0 }, // 1, 2, or 3
  nextInstalmentDate: { type: Date, default: null }, // Date of next instalment (legacy)
  perInstalmentAmount: { type: Number, default: 0 }, // Pending fees divided by instalment count
  isBajajEMI: { type: Boolean, default: false }, // Flag for Bajaj EMI
  isCheck: { type: Boolean, default: false }, // Flag for Check payment
  instalmentDates: [{ type: Date, default: null }], // Array to store multiple instalment dates
  instalmentAmounts: [{ type: Number, default: 0 }], // Array to store individual instalment amounts
},

workflow: {
  // counselor reviewed + submitted to admin
  counselorSubmittedToAdminAt: { type: Date },
  counselorSubmittedByEmail: { type: String, trim: true, default: "" },

  // admin final approval
  adminApprovedAt: { type: Date },
  adminApprovedByEmail: { type: String, trim: true, default: "" },
},  
  },

  { timestamps: true }
);

export default mongoose.model("Admission", AdmissionSchema);
