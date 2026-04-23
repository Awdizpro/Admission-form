// server/src/services/pdf.service.js
import PDFDocument from "pdfkit";
import sharp from "sharp"; // ✅ for webp/other → png/jpeg conversion
import { uploadPDFStream } from "./storage.service.js";


/* ---------------------- image helpers ---------------------- */
// ✅ Accept PNG/JPEG directly; convert WEBP/others → PNG so pdfkit can embed them
const toImageBuffer = async (src) => {
  if (!src) return null;

  const normalizeForPDF = async (buf, contentTypeHint = "") => {
    const ct = (contentTypeHint || "").toLowerCase();
    if (ct.includes("jpeg") || ct.includes("jpg") || ct.includes("png")) return buf;
    try {
      return await sharp(buf).png({ quality: 90 }).toBuffer();
    } catch {
      try { return await sharp(buf).jpeg({ quality: 90 }).toBuffer(); } catch { return null; }
    }
  };

  // Base64 data URL
  if (typeof src === "string" && src.startsWith("data:")) {
    try {
      const [meta, b64] = src.split(",");
      const ct = (meta.match(/^data:(.*?);base64$/i)?.[1] || "").toLowerCase();
      const raw = Buffer.from(b64, "base64");
      return await normalizeForPDF(raw, ct);
    } catch {
      return null;
    }
  }

  // Remote URL (e.g., Cloudinary)
  try {
    const r = await fetch(src);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const ab = await r.arrayBuffer();
    const raw = Buffer.from(ab);
    if (ct.includes("jpeg") || ct.includes("jpg") || ct.includes("png")) return raw;
    return await normalizeForPDF(raw, ct);
  } catch {
    return null;
  }
};

/** Draw image centered inside a box (maxW x maxH) */
async function drawCenteredImage(doc, buf, x, y, maxW, maxH) {
  if (!buf) return;
  try {
    const meta = await sharp(buf).metadata();
    if (meta?.width && meta?.height) {
      const scale = Math.min(maxW / meta.width, maxH / meta.height);
      const w = meta.width * scale;
      const h = meta.height * scale;
      const cx = x + (maxW - w) / 2;
      const cy = y + (maxH - h) / 2;
      doc.image(buf, cx, cy, { width: w, height: h });
      return;
    }
  } catch {}
  doc.image(buf, x, y, { fit: [maxW, maxH] }); // fallback
}

/* ---------------------- page metrics ----------------------- */
const PAGE_W    = 595.28;              // A4 width (pts)
const MARGIN    = 36;                  // 0.5"
const CONTENT_W = PAGE_W - MARGIN * 2; // inner width

/* ---------------------- tiny utils ------------------------- */
const keep = (v, d = "") => (v === 0 ? "0" : v ? String(v) : d);

function ensureSpace(doc, needed = 50) {
  if (doc.y + needed > doc.page.height - MARGIN) doc.addPage();
}

function heading(doc, text) {
  doc.font("Helvetica-Bold").fontSize(16).text(text, { align: "center" }).moveDown(0.4);
  doc.font("Helvetica");
}

/** Measure a text’s height with given font/size/width (no drawing). */
function heightOf(doc, text, { width, lineGap = 2, font = "Helvetica", size = 10 }) {
  const f0 = doc._font ? doc._font.name : "Helvetica";
  const s0 = doc._fontSize || 10;
  doc.font(font).fontSize(size);
  const h = doc.heightOfString(keep(text, "-"), { width, lineGap });
  doc.font(f0).fontSize(s0);
  return Math.max(h, 12);
}

/** Auto-height, full-width section with title bar. Awaits async content. */
async function sectionBox(doc, titleText, draw) {
  ensureSpace(doc, 45);
  const x = MARGIN, w = CONTENT_W, yTop = doc.y;

  // title stripe
  doc.save()
    .rect(x, yTop, w, 26).fill("#f2f2f2")
    .fillColor("#000").font("Helvetica-Bold").fontSize(13)
    .text(titleText, x + 10, yTop + 6)
    .restore();

  const area = { x, y: yTop + 32, w };
  doc.y = area.y;

  await draw(area);

  const yBottom = doc.y + 6;
  doc.rect(x, yTop, w, yBottom - yTop).stroke();
  doc.y = yBottom + 4; // spacing
}

/** Two-column grid: each row’s height = max(left,right) (no overlap). */
function twoColGrid(doc, area, pairs, opts = {}) {
  const pad = opts.pad ?? 10;
  const gapCols = opts.gapCols ?? 20;

  const labelRatio = opts.labelRatio ?? 0.40;
  const colW = (area.w - pad * 2 - gapCols) / 2;
  const labelW = Math.max(110, Math.floor(colW * labelRatio));
  const valueW = colW - labelW - 4;
  const lineGap = 2;

  let y = doc.y;

  for (let i = 0; i < pairs.length; i += 2) {
    const L = pairs[i] || { label: "", value: "" };
    const R = pairs[i + 1] || null;

    const lH = Math.max(
      heightOf(doc, L.label, { width: labelW, lineGap, font: "Helvetica-Bold", size: 11 }),
      heightOf(doc, keep(L.value, "-"), { width: valueW, lineGap, font: "Helvetica", size: 11 })
    ) + 4;

    let rowH = lH;
    if (R) {
      const rH = Math.max(
        heightOf(doc, R.label, { width: labelW, lineGap, font: "Helvetica-Bold", size: 11 }),
        heightOf(doc, keep(R.value, "-"), { width: valueW, lineGap, font: "Helvetica", size: 11 })
      ) + 4;
      rowH = Math.max(lH, rH);
    }

    ensureSpace(doc, rowH + 4);

    // draw left
    doc.font("Helvetica-Bold").fontSize(11)
       .text(L.label, area.x + pad, y, { width: labelW, lineGap });
    doc.font("Helvetica").fontSize(11)
       .text(keep(L.value, "-"), area.x + pad + labelW + 8, y, { width: valueW, lineGap });

    // draw right
    if (R) {
      const rx = area.x + pad + colW + gapCols;
      doc.font("Helvetica-Bold").fontSize(11)
         .text(R.label, rx, y, { width: labelW, lineGap });
      doc.font("Helvetica").fontSize(11)
         .text(keep(R.value, "-"), rx + labelW + 8, y, { width: valueW, lineGap });
    }

    y += rowH;
  }
  doc.y = y;
}

/** Education table — full width inside section, with header stripe + row lines. */
function drawEduTable(doc, area, rows) {
  const pad = 10;
  const cols = [
    { key: "qualification", title: "Qualification / Exam", w: Math.floor(area.w * 0.30) },
    { key: "school",        title: "School / College",     w: Math.floor(area.w * 0.34) },
    { key: "year",          title: "Year",                 w: Math.floor(area.w * 0.16) },
    { key: "percentage",    title: "% Marks",              w: Math.floor(area.w * 0.16) },
  ];
  const gap = 8;
  const lineGap = 3;

  const hY = doc.y;
  doc.save().rect(area.x, hY - 2, area.w, 26).fill("#f2f2f2").restore();

  doc.font("Helvetica-Bold").fontSize(11);
  let cx = area.x + pad;
  cols.forEach(c => { doc.text(c.title, cx, hY + 2, { width: c.w }); cx += c.w + gap; });
  doc.moveDown(0.5);

  doc.font("Helvetica").fontSize(11);
  rows.forEach(r => {
    // Step 1: Calculate max height for this row (with text wrapping)
    let maxHeight = 18;
    for (const c of cols) {
      const cellText = keep(r[c.key], "-");
      const h = doc.heightOfString(cellText, { width: c.w - 2, lineGap });
      maxHeight = Math.max(maxHeight, h);
    }
    maxHeight += 8; // extra padding
    
    // Step 2: Ensure space and set row start position
    ensureSpace(doc, maxHeight);
    const rowStartY = doc.y;
    
    // Step 3: Draw each cell at same Y position (all columns in one row)
    let cursor = area.x + pad;
    for (const c of cols) {
      doc.text(keep(r[c.key], "-"), cursor, rowStartY, { 
        width: c.w - 2, 
        lineGap,
        align: c.key === "year" || c.key === "percentage" ? "center" : "left"
      });
      cursor += c.w + gap;
    }
    
    // Step 4: Move doc.y to after the tallest cell (not after each cell)
    doc.y = rowStartY + maxHeight - 4;
    
    // Step 5: Draw row separator line
    doc.save().strokeColor("#e5e5e5")
      .moveTo(area.x, doc.y)
      .lineTo(area.x + area.w, doc.y)
      .stroke()
      .restore();
    doc.moveDown(0.3);
  });
}

/** Highlighted notice box */
function noticeBox(doc, text) {
  const x = MARGIN, w = CONTENT_W, h = 40;
  ensureSpace(doc, h + 6);
  const y = doc.y;
  doc.save()
    .rect(x, y, w, h).fill("#FFF9C4")
    .fillColor("#7A5E00").font("Helvetica-Bold").fontSize(11)
    .text(text, x + 12, y + 11, { width: w - 24, align: "center" })
    .restore();
  doc.moveDown(0.5);
}

/* ---------------------- defaults --------------------------- */
const DEFAULT_BOOTCAMP_TNC = `Students Agreement Copy – Fast Track Bootcamp Courses with Guaranteed Placement

Dear Student,
Welcome to Awdiz! Your Trusted Learning Partner.
Thanks for choosing us!!

This agreement is mandatory and must be read, agreed upon, and signed by all candidates enrolling in any Awdiz Fast track Bootcamp Job Guaranteed Programs. By signing this agreement, the candidate provides a legal affirmation to follow all internal rules, regulations, policies, and guidelines issued by Awdiz Management and agrees to abide by them throughout the entire duration of the training program.

We ensure that every student experiences a comfortable, supportive, and structured learning environment, making their journey from a learner to an IT professional memorable and impactful at every stage of personal and technical growth. The quality of our programs has been consistently appreciated by our hiring partners, many of whom have been associated with Awdiz for several years. Their continued trust is a strong validation that our training methodology and candidate learning outcomes are on the right track.

At Awdiz, our training process is simple and outcome-oriented, built around a continuous cycle of Train - Assess - Retrain - Reassess - Until Placement. We closely monitor each student's learning progress at every phase of the program and provide timely feedback and improvement plans to ensure the training remains effective and result-driven.

To maximize learning outcomes, we leverage all modes of training including Classroom, Online, Hybrid, and Recorded Sessions, ensuring students gain full access to our training resources. Student performance is regularly evaluated through weekly, monthly, and module-based assessments, live projects, and practical evaluations, enabling consistent improvement and industry readiness.

All enrolled students are onboarded onto Awdiz's internal Learning Management System (LMS), which tracks and monitors training attendance, assessments, mock interviews, resume development, internship details, interview opportunities, and interview feedback until the student successfully secures employment.

The purpose of monitoring the complete learning journey is to deliver practical, industry-relevant training in the simplest and most effective manner. Continuous monitoring helps identify individual learning gaps, convert weaknesses into strengths, and create a structured pathway that increases the student's chances of long-term success.

To achieve the above objectives and ensure that students remain focused on their career goals, Awdiz has defined certain terms and conditions designed to promote discipline, accountability, and consistent progress. These guidelines are intended to support both the students and Awdiz in maintaining a structured learning environment, ultimately helping students work toward their goal of securing a well-paying IT role.

By enrolling in the program, the student confirms acceptance of the below terms and agrees to strictly follow them throughout the entire duration of the training program.

Special Provision for Placement Readiness Program Candidates

In addition to students enrolled in Awdiz Master Job Guaranteed Programs, Awdiz also provides placement opportunities to candidates who have completed training from other institutes or through self-learning and wish to avail Awdiz fast track bootcamp styled short training session with placement support.

To ensure quality, standardization, and job-readiness of such candidates, it is mandatory for all external candidates to undergo Awdiz's structured evaluation and preparation process before becoming eligible for placement services.

Accordingly, all such candidates must compulsorily opt for any one of the following Awdiz programs:

1. Self-Paced Learning Program (Recorded Training Access)
   Candidates must go through Awdiz's recorded training modules relevant to their domain for revision, alignment with industry requirements, and interview preparation.

2. Fast Track Bootcamp Program (10–15 Days)
   Candidates must attend a short-duration intensive bootcamp conducted by Awdiz, focused on:
   - Interview preparation
   - Practical scenarios
   - Resume building
   - Mock interviews
   - Industry-level Q&A practice

Upon completion of either of the above options, the candidate must:
- Appear for a Final Mock Evaluation conducted by Awdiz
- Achieve the minimum qualifying performance level as defined by Awdiz

Only after successfully clearing this final mock evaluation shall the candidate be considered eligible for participation in Awdiz Placement Process.

This process ensures that all candidates—whether trained at Awdiz or externally—meet the same quality standards expected by hiring partners.

Placement Eligibility Criteria (Revised – Applicable for All Candidates)

To qualify for participation in the Awdiz placement process, candidates must meet the following mandatory conditions:

- The candidate must have successfully completed either:
  - Awdiz full training program
  - OR Awdiz Self-Paced Learning Program
  - OR Awdiz Fast Track Bootcamp Program
- The candidate must appear for and clear the Final Mock Evaluation conducted by Awdiz
- The candidate must obtain a minimum qualifying score as defined by Awdiz in the final mock interview/assessment
- The candidate must have cleared all fee obligations
- Final approval for placement eligibility shall be provided by the Centre Manager / Placement Team

Only candidates who meet the above criteria shall be considered "Job Ready" and eligible to enter the placement process.

Awdiz does not provide standalone placement services. All placement support is offered only as part of structured training, evaluation, and career preparation programs conducted by Awdiz.

Terms & Conditions – Fast Track Bootcamp Programs in IT Infrastructure and Software Development

Any student who fails to meet the eligibility criteria mentioned below shall not be eligible to participate in Awdiz placement activities. By agreeing to these terms, the student provides a legal reaffirmation of their commitment to remain serious, disciplined, and compliant throughout the entire training duration. In such cases of non-compliance, Awdiz shall not be held responsible or liable for the student's inability to secure employment.

• Admission eligibility for Awdiz programs is defined based on course requirements, industry demands, and role-specific working conditions.

- IT Infrastructure programs (including Networking, Systems, Cybersecurity, Cloud/AWS) require candidates who are within the defined age eligibility range specified by Awdiz and are fully willing to work in rotational shifts, extended hours, and travel to client locations as per company and client policies. Candidates unwilling to comply with shift timings or travel requirements may be deemed ineligible for placement support.

- Software Development programs are primarily intended for younger candidates and recent IT graduates who have completed a valid IT-related degree with satisfactory academic performance. Preference is given to recent pass-outs to align with fresher hiring trends in the software industry.

• To ensure effective learning and readiness for placement, candidates must maintain 100% attendance during the Fast Track Bootcamp. The duration of the bootcamp shall be communicated to the candidate at the time of admission. In case a session is missed, the student may attend a backup session in another batch, subject to prior notification to the Awdiz team. A maximum of two (2) session backups is permitted. Exceeding this limit will require special written approval from the Centre Manager, failing which the student shall be ineligible for participation in Awdiz placement programs.

• To qualify for the placement process, students must achieve a minimum score of 85% in the final mock interview, and mandatory soft-skills training. Failure to meet this requirement will render the student ineligible for placement activities. Such students must undergo additional training, assessment, and mock interview repetitions until the required performance criteria are met, after which they may become eligible to re-enter the placement process, subject to Awdiz approval.

• To meet course completion requirements, students must fully complete all mandatory activities for each module, including attendance, assignments, quizzes, internships, mock sessions, internal assessments, and prescribed self-learning tasks, within the specified timelines. Failure to comply with these requirements may result in the student being declared ineligible for participation in Awdiz placement programs.

• Attendance in all mandatory soft-skills training sessions, including English communication, aptitude, and personality development, is compulsory for all candidates. 100% attendance will be recorded and is required for eligibility in the placement process. These sessions are generally conducted on weekends to ensure that regular technical training schedules remain unaffected.

• Batch changes are generally not permitted and will be considered only under exceptional circumstances, such as valid medical or educational reasons, subject to prior written approval from the Centre Manager. If approved, a one-time batch change processing fee of INR 15,000/- shall be applicable. Batch change, if granted, will be allowed only once during the entire training duration.

• Any participant who chooses to withdraw, discontinue, or exit from a Fast Track Bootcamp Programs —either before the commencement of sessions or after training has begun—shall not be eligible for any refund, adjustment, or transfer of fees under any circumstances.

• Ongoing students may be permitted to take a temporary break of up to fifteen (15) days, subject to prior written approval from the Centre Manager, and only in cases of examinations, medical emergencies, or other valid and justifiable reasons. Any break beyond this period or without approval may impact the student's training continuity and placement eligibility.

• Any act of misconduct, indiscipline, plagiarism, cheating during assessments, threatening behaviour, harassment, use of abusive language, violation of institute policies, or misuse of Awdiz resources may result in immediate termination from the program without any refund, at the sole discretion of Awdiz Management.

• Students are required to strictly adhere to the prescribed fee payment schedule. Any delay or non-payment beyond the permitted due date may result in temporary or permanent suspension of training services and access to the Awdiz LMS, until dues are fully cleared.

• A course shall be deemed successfully completed only when the candidate has cleared all fee obligations, completed all modules, assignments, assessments, mock sessions, and faculty-assigned final projects, and met the required attendance criteria for both technical and soft-skills training. Final course completion is subject to review and approval by the Centre Manager. Upon successful completion, a course completion certificate will be issued, and formal approval will be granted to the Placement Team to initiate placement services.

• Students who score above 85% in final mock evaluations and maintain 100% attendance will be automatically eligible for placement services. Such students will not be required to undergo training repetition and may be considered for internship opportunities, if deemed necessary, at the sole discretion of Awdiz Management and the Placement Team, to further enhance confidence and job readiness.

• Students who score less than 85% in mock evaluations and/or maintain less than 85% attendance, and who wish to revise or improve their performance, may opt for a one-time batch repetition, subject to prior approval from Awdiz Management. Batch repetition may be permitted in any one of the following formats: after completing the current training, during the ongoing training to revise completed topics while continuing pending modules with a new batch, or by restarting the program afresh with a new batch. Any batch repetition, if approved, shall be allowed only once during the entire training duration and may attract applicable repetition or administrative fees as decided by Awdiz. Placement eligibility and timelines shall stand deferred until the candidate successfully completes the repeated training and meets all required performance and attendance criteria.

• A candidate shall be deemed job-ready only upon receiving formal approval from the Centre Manager after verification of required attendance, successful completion of final training assessments, and confirmation of full fee payment. Upon such approval, the candidate becomes eligible to receive job opportunities shared by Awdiz. Awdiz endeavours to facilitate placement opportunities for job-ready candidates within a period of up to 180 days from the date of formal placement approval granted after successful training completion. Placement timelines may vary based on candidate performance, interview availability, and prevailing market conditions.

• Awdiz shall not be held responsible for any delays, consequences, or commitments arising due to course interruptions or extensions caused by the student for personal, educational, or medical reasons. Such delays may impact course completion timelines and placement opportunities, for which Awdiz shall bear no liability.

• Candidates must be willing to accept employment opportunities across PAN India and shall not decline job offers solely on the basis of location. Declining an offer for any reason may result in the candidate being removed from further placement services. In such cases, the candidate will be required to seek readmission into the program and pay the full applicable fees again in order to re-enter the interview process.

• In exceptional circumstances, location-specific preferences may be considered at the time of admission, subject to prior written approval from the Centre Manager. However, in such cases, Awdiz does not guarantee the number of interview opportunities available for the preferred location.

• Awdiz reserves the sole and absolute right to appoint, replace, or reassign trainers at its discretion based on academic, operational, or business requirements. Students shall not have the right to request, insist upon, or demand training from any specific trainer at any stage of the program. Any such change in trainer shall not affect the validity of the course, training outcomes, or the candidate's placement eligibility.

• Awdiz reserves the right to conduct re-tests, mock evaluations, and to review or accept assignments at any time within a period of up to thirty (30) days from the date of the student's initial attempt or submission. In the event that a trainer, evaluator, or assessor is not immediately available, the student shall be required to wait until such evaluation or assessment is scheduled by Awdiz, without any claim or objection.

• Candidates are expected to possess sufficient proficiency in English to communicate clearly and effectively during interviews and workplace interactions. Candidates who do not meet the required proficiency standards may be required to undergo additional language or communication training with a designated instructor until the expected level is achieved, which may impact placement timelines.

• Students must be willing to attend interviews and participate in internships in any mode as determined by the employer, including in-person, online, or hybrid formats. Awdiz does not guarantee online interviews, work-from-home (WFH) roles, or remote internships. Candidates shall not refuse or decline any interview, job opportunity, or internship on the basis of interview mode, job location, work arrangement, or internship format. Any refusal or non-participation may result in the candidate being declared ineligible for further placement or internship opportunities, at the sole discretion of Awdiz.

• PDFs, presentations, recorded videos, and other required study materials will be shared in digital format after each class or module, as applicable. Access to such videos and study materials will be provided for a defined and time-bound period to encourage timely completion of assignments, assessments, and self-learning activities. Student access, usage, and progress may be monitored through the Awdiz LMS. All study materials are the intellectual property of Awdiz and are strictly for personal learning use only. Sharing, copying, recording, downloading, redistribution, or commercial use of these materials, in any form, is strictly prohibited and may result in disciplinary action, including termination from the program.

• If a student opts for an internship prior to placement, or if the Awdiz Placement Team determines that an internship is required to further enhance the candidate's technical skills, the candidate must be willing to relocate to the location assigned by Awdiz and be available to commence the internship immediately upon completion of training. Internships may be paid or unpaid, depending on the opportunity and employer terms. The candidate shall not decline or refuse the internship on the basis of stipend status, location, or any other reason, failing which the candidate may be declared ineligible for further placement services.

• Awdiz will make reasonable efforts to schedule interviews in virtual mode wherever possible, including for online or outstation candidates. However, if a client requires a face-to-face interview, the candidate must be physically available at the location assigned by Awdiz for a minimum period of sixty (60) days to participate in the placement process. Travel, accommodation, and related expenses during this period shall be the sole responsibility of the candidate. Availability at the assigned location does not guarantee a specific number of interviews, as interview opportunities depend on client requirements and hiring conditions. Failure to comply with these requirements may impact the candidate's placement eligibility.

• Candidates are required to attend all interviews arranged by Awdiz or its authorized placement partners. If a candidate is unable to attend a scheduled interview, prior written approval must be obtained from the Placement Manager via email. Valid justifications for non-attendance may include medical emergencies, officially scheduled examinations, or other exceptional circumstances supported by appropriate documentation. Missing two (2) or more interviews arranged by Awdiz without approved justification shall result in the candidate being declared ineligible for further placement services and interview opportunities.

• The Fast Track Bootcamp Programs are offered as job-guaranteed packages; however, Awdiz does not commit to a fixed salary for any candidate. Offered compensation will be based on the role, company, market conditions, and candidate performance, and is generally expected to fall within a range of INR 2.0 LPA to INR 6.0 LPA or 20%-30% hike based on the last salary, if the candidate has genuine experience in the same field. Salary discussions and negotiations are conducted directly between the candidate and the employer during the interview process. As part of the training, Awdiz provides guidance and preparation to help candidates approach salary discussions confidently and maximize their potential compensation for the offered role.

• If an employer specifies a fixed-duration internship prior to confirmation on permanent payroll, or includes a defined employment bond period in the offer letter, the candidate must be willing to accept such conditions and sign the required bond agreement. These conditions are common for fresher-level roles and form part of the employer's hiring policy. Declining a job offer on the basis of internship duration or bond requirements is not permitted and may result in the candidate being declared ineligible for further placement services. Any bond agreement, duration, or related obligations shall be strictly between the candidate and the employer, and Awdiz shall not be held responsible or liable for the terms, enforcement, or consequences arising from such agreements.

• Students must be willing to accept employment offers under direct payroll or third-party payroll arrangements, including roles involving client-site deployment. Candidates should be comfortable working with organizations of all sizes, including startups, service providers, multinational companies, banking and financial institutions, educational institutions, and other client-driven environments. Declining an offer based on payroll structure, company size, contract nature, work shifts, or deployment model shall not be permitted and may result in ineligibility for further placement services.

• Based on the course selected by the student, the Fast Track Bootcamp job-guaranteed programs cover multiple topics designed to prepare candidates for a wide range of IT infrastructure and software development roles. Training duration typically ranges between 10 days – 30 Days, depending on the course, and will be clearly communicated to the student at the commencement of training. The placement and interview process may begin after completion of certain key modules, even if the full course curriculum has not yet been completed. Training for the remaining modules will continue in parallel with interviews to ensure that capable and job-ready candidates can begin their careers without unnecessary delay.

• Under Awdiz's Job Guarantee Programs, students are eligible for fresher-level roles relevant to the course enrolled. Job designations may vary across companies; however, if the offered role aligns with the skills and technologies covered in the training, the student is required to accept the offer. Refusal based solely on designation, employer type, or payroll model (direct or third-party) may result in disqualification from further placement services. Awdiz reserves the right to validate role alignment before enforcing this clause.

| Course | Details |
|---|---|
| **Networking and System Expert course** | As covers vast IT topics in various technologies of System, Server and Networking Ticketing Tool Monitoring Tool so student can be placed in different L1 roles like Desktop Support Engineer, IT Support Engineer, Server Administrator, Windows Admin, Server Engineer, NOC, Field Support Engineer, Technical Support Engineer, IT Engineer, Network Engineer, System Admin, IT Field Engineer, Trainee, Network Support Engineer and similar positions in IT Infra Division. |
| **Networking, System, and Cybersecurity course** | As this course covers an extensive set of modules including Networking Fundamentals, Windows/Linux Administration, Firewalls, Ticketing Tools, Monitoring Tools, and basic Cybersecurity concepts, students can be placed in multiple fresher-level IT infrastructure and security-related roles. These roles include, but are not limited to: Network Engineer, System Administrator, IT Support Engineer, Desktop Support Engineer, Security Analyst - L1, SOC Analyst - Trainee, NOC Engineer, Windows/Linux Admin, IT Security Support, Technical Support Engineer, Network Support Engineer, Infrastructure Support Executive, Security Operations Intern, Helpdesk Engineer, IT Field Engineer, Cybersecurity Analyst – Intern and similar positions in IT Infra Division. |
| **Networking, System, and AWS Cloud course** | As this course delivers in-depth training on Networking, Windows/Linux Administration, Server & System Monitoring, Cloud Fundamentals, AWS Services (EC2, S3, IAM, VPC, etc.), and Ticketing Tools, students become eligible for various entry-level roles in IT Infrastructure and Cloud Support. These roles include, but are not limited to: Cloud Support Engineer – L1, AWS Cloud Administrator – Trainee, System Administrator, Network Engineer, Cloud Operations Associate, Infrastructure Support Engineer, Desktop Support Engineer, Server Admin, DevOps Support – Intern, NOC Engineer, Cloud Technical Support, IT Support Engineer, AWS Trainee Engineer, Cloud Helpdesk Engineer and similar positions in IT Infra Division. |
| **Full Stack Developer Course** | As this course at AWDIZ covers comprehensive topics across both Java Full Stack (Core Java, JDBC, Spring Boot, REST APIs, MySQL) and MERN Stack (MongoDB, Express.js, React.js, Node.js), along with essential front-end skills (HTML, CSS, JavaScript, Bootstrap) and version control (Git/GitHub), students become eligible for a broad range of fresher-level software development roles. These roles include, but are not limited to: Full Stack Developer, Java Developer, MERN Stack Developer, React Developer, Backend Developer (Java/Node.js), Frontend Developer, Web Developer, Application Developer, Software Engineer, UI Developer, API Developer, Software Development Intern, Trainee Software Engineer, Junior Full Stack Engineer, Graduate Engineer Trainee (GET) and similar positions in IT Development. |
| **Data Analytics and Data Science course** | As this course encompasses a broad curriculum including statistics, Excel, SQL, Python, Power BI, Tableau, Machine Learning, and data visualization tools, students can be placed across various fresher-level analytical and data-centric roles in IT and non-IT companies. These include, but are not limited to: Data Analyst, Business Analyst, Data Science Intern, Junior Data Scientist, MIS Analyst, Reporting Analyst, BI Developer, Research Analyst, SQL Analyst, Python Developer (Data Focused), Data Engineer - Intern, Associate Analyst, Insight Analyst, Decision Science Analyst, Analytics Executive, ML Trainee and similar positions in IT Development. |

• Once a student is shortlisted after final discussions or receives a job offer, the opportunity must be accepted. Declining such an opportunity will result in immediate cancellation of placement services, and the student will be required to seek re-admission by paying the full course fee again to re-enter the placement process.

• Awdiz shall not be held responsible if a candidate voluntarily resigns from a company or is terminated by the employer due to performance issues, misconduct, or violation of company policies. Once a candidate accepts a job offer from any company, whether secured independently or through Awdiz, the candidate shall not be eligible for any further placement assistance or fee refunds under the Awdiz 100% Job Guarantee Program.

• Post-placement support of up to thirty (30) days will be provided to students who have completed full fee payment and have met the minimum eligibility criteria of 100% attendance and 85% mock assessment scores, as per Awdiz policy. Such support shall be extended only under specific circumstances, including layoffs or downsizing, offer revocation, assignment to a non-IT role, unethical working conditions, or salary terms not being honoured, provided that all such claims are supported by valid legal or official documentation.

• Post-placement support shall not be extended to candidates who are terminated or exit employment due to misconduct, behavioural or disciplinary issues, absconding from duty, inadequate technical competency, irregular attendance, voluntary resignation, mismatch in educational or experience documents, unrealistic salary expectations, inability to manage job-related stress, dissatisfaction with workplace culture, or unwillingness to relocate or work in rotational shifts.

• Once a candidate has availed a second job opportunity through Awdiz that meets the eligibility criteria for post-placement support, the candidate's training and placement services shall be deemed complete. Thereafter, the candidate shall not be eligible to re-approach Awdiz for any further placement assistance or training repetitions under the program.

• Students pursuing regular degree programs shall become eligible for participation in Awdiz Job Guarantee Programs only after a minimum period of three (3) months from the completion of their graduation. If a candidate chooses to pursue higher education at any stage after enrolment, the Job Guarantee agreement shall stand cancelled, and the candidate shall not be eligible for any training repetitions, placement support, or fee refunds under the program.

• Awdiz reserves the right to use a candidate's placement-related information, name, photographs, images, and videos for promotional, marketing, branding, and website collateral purposes, irrespective of whether the placement was secured through Awdiz or independently by the candidate. In the event that a candidate declines to provide a testimonial after securing employment, Awdiz shall still be entitled to use such placement-related details and visual content without requiring any additional consent. No confidential or sensitive personal information shall be disclosed as part of such usage.

• For Awdiz to provide placement assistance, the learner must successfully complete the course in accordance with Awdiz's prescribed academic standards and clear all mandatory career development activities, assignments, and evaluations as defined in the course curriculum or as assigned by the Awdiz career or placement team. In addition, the learner must have successfully completed their formal graduation. Learners who have not completed their graduation shall not be eligible to participate in placement services offered by Awdiz.

• All courses offered by Awdiz are governed by a non-refundable and non-transferable policy. Awdiz does not provide refunds under any circumstances once a candidate has been admitted into a course. Upon payment of the course fee and confirmation of admission, the candidate is deemed to have committed to completing the course. Candidates are advised to fully understand the course structure, requirements, and obligations prior to enrolment and fee payment. Any doubts or clarifications must be addressed with the Awdiz Admissions Team before making the payment, as post-admission requests for refunds, transfers, or cancellations shall not be entertained.

• Under the Awdiz 100% Job Guaranteed Program, if a student is unable to secure placement after attending the minimum number of interviews specified in this agreement, the student must be willing to accept job offers at any location and across suitable entry-level roles, irrespective of specialization or qualification alignment. This provision enables Awdiz to fulfil its commitment to 100% placement support for enrolled candidates. The 100% Job Guarantee implies that Awdiz will continue to facilitate interview opportunities until the student is placed or receives a minimum job offer with a compensation range of INR 12,000 to INR 15,000 CTC. Acceptance of such an offer shall be mandatory to satisfy the job guarantee obligation under this program.

• Awdiz shall not be held responsible or liable for any delay or inability to provide job placement opportunities arising from economic downturns, hiring freezes, pandemics, government restrictions, or any other events beyond the reasonable control of Awdiz.

• Learners are required to respond to all interview- or job-offer-related communications from Awdiz or its authorized representatives within twenty-four (24) hours, clearly confirming acceptance or rejection, as applicable. Such communication may be sent via email, phone call, messaging platforms including WhatsApp, or through the Awdiz LMS. Failure to respond within the stipulated timeframe may result in suspension or cancellation of placement eligibility and support.

• Awdiz reserves the right to make changes to course fees, office locations, trainers, course content, batch schedules, timings, and batch start dates based on academic, operational, or business requirements. In the event of any such changes, Awdiz shall make reasonable efforts to inform students within an appropriate timeframe to ensure continuity of training.

• Students must strictly adhere to the payment schedule agreed upon at the time of admission. Any delay beyond the due date shall result in the following actions:

- Immediate suspension of access to the Awdiz LMS, recorded lectures, assessments, test portals, and participation in classroom or online sessions.
- If outstanding dues remain unpaid for more than fifteen (5) days, Awdiz reserves the right to terminate the student's admission without any refund.
- To resume training after suspension, the student must clear all pending dues and may be required to pay a reactivation fee of INR 2,000, subject to approval by the Centre Manager.
- During any period of payment default or suspension, the student's placement eligibility and placement timelines shall remain paused and shall resume only after full clearance of dues and reinstatement of training access.

• Students opting for EMI (Equated Monthly Instalment) or instalment-based payment plans are required to make all payments on or before the respective due dates without fail. Any missed, delayed, or bounced EMI shall attract the following consequences:

- Immediate suspension of access to all training sessions, the Awdiz LMS, assessments, recorded content, and placement-related services until all outstanding dues are cleared.
- If two (2) or more EMIs are missed, the student shall be treated as a defaulter, and the entire remaining course fee shall become immediately payable in a single lump sum.
- In the event of bounced EMIs, failed auto-debits, or payment defaults, the student shall be solely responsible for any penalties, late fees, legal action, recovery proceedings, or notices initiated by the financing partner, NBFC, or bank.
- Awdiz shall not be held responsible or liable for any legal consequences, reputational impact, credit score deterioration, or third-party actions arising due to the student's financial default with the EMI provider or bank.
- Continued non-payment for a period exceeding thirty (30) days shall result in permanent cancellation of admission and Job Guarantee services, without any refund.

In the event of default, delay, or non-payment of fees, including EMI or loan repayments to Awdiz, its NBFC/loan partners, or through NACH or any other approved payment mode, Awdiz reserves the right to restrict or revoke the participant's access to the learning platform, training sessions, placement services, and related facilities. In such cases, the participant shall not be eligible for any course completion certificate.

• If a learner fails to demonstrate sincere, consistent, and genuine efforts toward securing employment, refuses to accept a job offer, or after accepting an offer fails to join or continue in the employment for any reason whatsoever, including roles requiring relocation to designated locations or any other cities as prescribed by Awdiz from time to time, Awdiz reserves the right to suspend or permanently withdraw placement support and related services.

• Awdiz retains sole and absolute discretion to introduce, modify, or withdraw scholarships, discounts, or special schemes from time to time for selected categories of participants, for specific periods, or under such terms and conditions as it may deem appropriate.

• The student agrees to fully indemnify and hold harmless Awdiz Institute from and against any and all claims, losses, liabilities, damages, costs, or expenses (including reasonable legal fees) arising out of or in connection with any act, omission, misrepresentation, or breach during the training and placement duration at Awdiz by the candidate.

• Awdiz reserves the sole and absolute right to approve or reject any request for batch change and/or adjustment. In the event of any violation of the code of conduct or other exceptional circumstances, Awdiz may take such action as it deems appropriate, including but not limited to denial of the request or reassignment, in accordance with its internal policies.

• Awdiz Management reserves the right, at its sole discretion, to modify, amend, update, or revise the rules, policies, terms, course structure, content, curriculum, and syllabus at any time based on market conditions, industry demand, academic relevance, or operational requirements. Awdiz may also add to or update these Terms and Conditions from time to time. Any such changes shall be communicated through official channels including, but not limited to, the Awdiz website, official email communication, LMS notifications, or other authorized modes. All amendments shall take effect immediately upon notification. Continued access to or use of Awdiz's services, training programs, platform, website, or LMS after such updates shall be deemed as unconditional acceptance of the revised Terms and Conditions. Any digital acknowledgment, confirmation via email or LMS, or continued usage shall constitute legally binding consent, equivalent to a physical signature.

• If a learner is rejected by three (3) or more companies due to inadequate performance, negative recruiter feedback, or lack of preparedness, Awdiz reserves the right to temporarily limit or pause further interview opportunities. Placement support shall resume only after the learner completes additional training, corrective measures, or preparation as prescribed by Awdiz.

• Failure to attend a scheduled interview without prior written approval from Awdiz shall be treated as a "No Show" and may result in immediate suspension or restriction of placement services.

• Learners must demonstrate willingness and availability for the following, as required by employers:
- Support roles, night shifts, or rotational shift schedules
- Internship opportunities, including potential conversion to full-time employment

• Fee Payment & Continuation of Training: The student acknowledges that payment of fees must be made strictly as per the agreed schedule. In case of delay or default, the institute reserves the right to:
- Suspend training access (online/offline)
- Apply late payment penalties
- Withhold certificates, assessments, or placement services
- until all outstanding dues are cleared.

• No Liability for Emotional Distress Due to Fee or Placement Issues: The student agrees that Fee-related actions (late fees, penalties, suspension, termination) and Placement timelines, interview outcomes, or delays may cause disappointment but shall not be considered mental harassment, emotional abuse, or exploitation by the institute, its staff, trainers, placement team, management, or directors.

• Self-Harm & Threat Disclaimer: The institute, its founders, directors, employees, placement officers, trainers, and representatives shall not be held responsible or liable for:
- Any self-harm, suicide attempt, threat, or emotional reaction by the student
- Any statements, messages, or allegations made by the student blaming the institute or its staff for such actions
- The student confirms that all decisions related to mental health, emotional well-being, and personal actions remain solely their own responsibility.

Any attempt to threaten, blackmail, or pressure the institute using self-harm or suicide claims shall be treated as misconduct and may result in immediate termination without refund.

• Harassment & False Allegation Protection: The student agrees that:
- Legitimate enforcement of institute policies does not amount to harassment
- Making false, exaggerated, or defamatory claims against staff or management—verbally, in writing, or on social media—will be treated as a serious disciplinary violation

The institute reserves the right to initiate legal action in such cases.

• Jurisdiction & Legal Protection: Any dispute, claim, or legal proceeding arising out of or in connection with this admission, training, or services shall be subject exclusively to the jurisdiction of the competent courts in Mumbai. The Institute's official records, including but not limited to written policies, payment receipts, LMS reports, emails, call records, SMS, and WhatsApp communication logs, shall be deemed valid, admissible, and conclusive legal evidence.

Any actions taken by Awdiz in accordance with the rules, policies, terms, and procedures set forth in this agreement, including but not limited to enforcement of eligibility criteria, payment compliance, training discipline, placement conditions, administrative decisions, or legal remedies, shall not be construed as harassment, coercion, discrimination, emotional abuse, or unfair treatment. Such actions are undertaken solely to uphold academic standards, operational integrity, financial discipline, regulatory compliance, and placement effectiveness. The student acknowledges and agrees that compliance with these terms is mandatory and that enforcement of the same does not give rise to any claim, grievance, or liability against Awdiz, its management, staff, trainers, or representatives, thereby concluding this agreement in full and final understanding.

Note: Complete fee payment is mandatory to apply for interviews. Candidate with pending fees (for any reason) will strictly not be allowed for any interviews arranged by Awdiz. Center Manager approval for complete full payment needs to be submitted to placement team for initiating interviews after training.

Kindly take admission at AWDIZ if the clauses of all the terms and conditions mentioned above are satisfying to you. Once you are admitted to our institute means you have read all our terms and conditions and you are agreeing with it.

I/We hereby declare that the information given by me on the Online/Offline Registration / Application Form etc. is correct to the best of my knowledge and belief. I/We understand that in the event of any information found to be incorrect or false, my admission may be cancelled.

I/We the Father/Mother/ or the student hereby severally and jointly declare that I / we have read and understood all the clauses contained in the Declaration on the Registration and agree to abide by them without any reservation or ambiguity and I/We have taken a print of all the terms and conditions for my future reference.

NOTE: This contract is valid for a period of 12 Months from the date of signing the contract.
Any legal matter/dispute is subject to Mumbai Jurisdiction only.

AWDIZ Office Address 1: 2nd Floor, Vashi Plaza Building, Office no. 421A, A Wing, Sector 17, Vashi, Navi Mumbai, Maharashtra 400703
Awdiz Office Address 2: Ground floor, A 791, KC Marg, next to 81 Aureate, Reclamation, Bandra West, Mumbai, Maharashtra 400050

Note: Kindly submit 2 Passport Size Photographs, One Digital Photograph for online records, PAN Card and Aadhar/ Driving License photocopy along with signed copy of this agreement.`;

const DEFAULT_TNC_TERMS = `Students Agreement Copy - Master Certification Courses with Guaranteed Placement

**Dear Student,**
**Welcome to Awdiz!** Your Trusted Learning Partner.
**Thanks for choosing us!!**

This agreement is mandatory and must be read, agreed upon, and signed by all candidates enrolling in any Awdiz Master Job Guaranteed Programs. By signing this agreement, the candidate provides a legal affirmation to follow all internal rules, regulations, policies, and guidelines issued by Awdiz Management and agrees to abide by them throughout the entire duration of the training program.

We ensure that every student experiences a comfortable, supportive, and structured learning environment, making their journey from a learner to an IT professional memorable and impactful at every stage of personal and technical growth. The quality of our programs has been consistently appreciated by our hiring partners, many of whom have been associated with Awdiz for several years. Their continued trust is a strong validation that our training methodology and candidate learning outcomes are on the right track.

At Awdiz, our training process is simple and outcome-oriented, built around a continuous cycle of Train - Assess - Retrain - Reassess - Until Placement. We closely monitor each student's learning progress at every phase of the program and provide timely feedback and improvement plans to ensure the training remains effective and result-driven.

All enrolled students are onboarded onto Awdiz's internal Learning Management System (LMS), which tracks and monitors training attendance, assessments, mock interviews, resume development, internship details, interview opportunities, and interview feedback until the student successfully secures employment.

The purpose of monitoring the complete learning journey is to deliver practical, industry-relevant training in the simplest and most effective manner. Continuous monitoring helps identify individual learning gaps, convert weaknesses into strengths, and create a structured pathway that increases the student's chances of long-term success.

To achieve the above objectives and ensure that students remain focused on their career goals, Awdiz has defined certain terms and conditions designed to promote discipline, accountability, and consistent progress. These guidelines are intended to support both the students and Awdiz in maintaining a structured learning environment, ultimately helping students work toward their goal of securing a well-paying IT role.

By enrolling in the program, the student confirms acceptance of the below terms and agrees to strictly follow them throughout the entire duration of the training program.

**Terms & Conditions – Master Programs in IT Infrastructure and Software Development**

**Any student who fails to meet the eligibility criteria mentioned below shall not be eligible to participate in Awdiz placement activities. By agreeing to these terms, the student provides a legal reaffirmation of their commitment to remain serious, disciplined, and compliant throughout the entire training duration. In such cases of non-compliance, Awdiz shall not be held responsible or liable for the student's inability to secure employment.**

• Admission eligibility for Awdiz programs is defined based on course requirements, industry demands, and role-specific working conditions.
  - IT Infrastructure programs (including Networking, Systems, Cybersecurity, Cloud/AWS) require candidates who are within the defined age eligibility range specified by Awdiz and are fully willing to work in rotational shifts, extended hours, and travel to client locations as per company and client policies. Candidates unwilling to comply with shift timings or travel requirements may be deemed ineligible for placement support.
  - Software Development programs are primarily intended for younger candidates and recent IT graduates who have completed a valid IT-related degree with satisfactory academic performance. Preference is given to age eligibility range specified by Awdiz to align with fresher hiring trends in the software industry.
• To ensure successful course completion, students must maintain a minimum attendance of 85% across all classroom and online sessions. In case a session is missed, the student may attend a backup session in another batch, subject to prior notification to the Awdiz team. A maximum of three (3) session backups is permitted. Exceeding this limit will require special written approval from the Centre Manager, failing which the student shall be ineligible for participation in Awdiz placement programs.
• To qualify for the placement process, students must achieve a minimum score of 85% in all daily, weekly, and monthly assessments, including MCQs, assignments, mock interviews, and mandatory soft-skills training. Failure to meet this requirement will render the student ineligible for placement activities. Such students must undergo additional training, assessment, and mock interview repetitions until the required performance criteria are met, after which they may become eligible to re-enter the placement process, subject to Awdiz approval.

• To meet course completion requirements, students must fully complete all mandatory activities for each module, including attendance, assignments, quizzes, internships, mock sessions, internal assessments, and prescribed self-learning tasks, within the specified timelines. Failure to comply with these requirements may result in the student being declared ineligible for participation in Awdiz placement programs.
• Attendance in all mandatory soft-skills training sessions, including English communication, aptitude, and personality development, is compulsory for all candidates. 100% attendance will be recorded and is required for eligibility in the placement process. These sessions are generally conducted on weekends to ensure that regular technical training schedules remain unaffected.
• Batch changes are generally not permitted and will be considered only under exceptional circumstances, such as valid medical or educational reasons, subject to prior written approval from the Centre Manager. If approved, a one-time batch change processing fee of INR 15,000/- shall be applicable. Batch change, if granted, will be allowed only once during the entire training duration.
• Any participant who chooses to withdraw, discontinue, or exit from a Job Guaranteed Program—either before the commencement of sessions or after training has begun—shall not be eligible for any refund, adjustment, or transfer of fees under any circumstances.
• Ongoing students may be permitted to take a temporary break of up to fifteen (15) days, subject to prior written approval from the Centre Manager, and only in cases of examinations, medical emergencies, or other valid and justifiable reasons. Any break beyond this period or without approval may impact the student's training continuity and placement eligibility.
• Any act of misconduct, indiscipline, plagiarism, cheating during assessments, threatening behaviour, harassment, use of abusive language, violation of institute policies, or misuse of Awdiz resources may result in immediate termination from the program without any refund, at the sole discretion of Awdiz Management.
• Students are required to strictly adhere to the prescribed fee payment schedule. Any delay or non-payment beyond the permitted due date may result in temporary or permanent suspension of training services and access to the Awdiz LMS, until dues are fully cleared.
• A course shall be deemed successfully completed only when the candidate has cleared all fee obligations, completed all modules, assignments, assessments, mock sessions, and faculty-assigned final projects, and met the required attendance criteria for both technical and soft-skills training. Final course completion is subject to review and approval by the Centre Manager. Upon successful completion, a course completion certificate will be issued, and formal approval will be granted to the Placement Team to initiate placement services.
• Students who score above 85% in mock evaluations and maintain more than 85% attendance will be automatically eligible for placement services. Such students will not be required to undergo training repetition and may be considered for internship opportunities, if deemed necessary, at the sole discretion of Awdiz Management and the Placement Team, to further enhance confidence and job readiness.
• Students who score less than 85% in mock evaluations and/or maintain less than 85% attendance, and who wish to revise or improve their performance, may opt for a one-time batch repetition, subject to prior approval from Awdiz Management. Batch repetition may be permitted in any one of the following formats: after completing the current training, during the ongoing training to revise completed topics while continuing pending modules with a new batch, or by restarting the program afresh with a new batch. Any batch repetition, if approved, shall be allowed only once during the entire training duration and may attract applicable repetition or administrative fees as decided by Awdiz. Placement eligibility and timelines shall stand deferred until the candidate successfully completes the repeated training and meets all required performance and attendance criteria.
• A candidate shall be deemed job-ready only upon receiving formal approval from the Centre Manager after verification of required attendance, successful completion of final training assessments, and confirmation of full fee payment. Upon such approval, the candidate becomes eligible to receive job opportunities shared by Awdiz. Awdiz endeavours to facilitate placement opportunities for job-ready candidates within a period of up to 180 days from the date of formal placement approval granted after successful training completion. Placement timelines may vary based on candidate performance, interview availability, and prevailing market conditions.
• Awdiz shall not be held responsible for any delays, consequences, or commitments arising due to course interruptions or extensions caused by the student for personal, educational, or medical reasons. Such delays may impact course completion timelines and placement opportunities, for which Awdiz shall bear no liability.
• Candidates must be willing to accept employment opportunities across PAN India and shall not decline job offers solely on the basis of location. Declining an offer for any reason may result in the candidate being removed from further placement services. In such cases, the candidate will be required to seek readmission into the program and pay the full applicable fees again in order to re-enter the interview process.
• In exceptional circumstances, location-specific preferences may be considered at the time of admission, subject to prior written approval from the Centre Manager. However, in such cases, Awdiz does not guarantee the number of interview opportunities available for the preferred location.
• Awdiz reserves the sole and absolute right to appoint, replace, or reassign trainers at its discretion based on academic, operational, or business requirements. Students shall not have the right to request, insist upon, or demand training from any specific trainer at any stage of the program. Any such change in trainer shall not affect the validity of the course, training outcomes, or the candidate's placement eligibility.
• Awdiz reserves the right to conduct re-tests, mock evaluations, and to review or accept assignments at any time within a period of up to thirty (30) days from the date of the student's initial attempt or submission. In the event that a trainer, evaluator, or assessor is not immediately available, the student shall be required to wait until such evaluation or assessment is scheduled by Awdiz, without any claim or objection.
• Students must be willing to attend interviews and participate in internships in any mode as determined by the employer, including in-person, online, or hybrid formats. Awdiz does not guarantee online interviews, work-from-home (WFH) roles, or remote internships. Candidates shall not refuse or decline any interview, job opportunity, or internship on the basis of interview mode, job location, work arrangement, or internship format. Any refusal or non-participation may result in the candidate being declared ineligible for further placement or internship opportunities, at the sole discretion of Awdiz.
• Students must be willing to attend interviews and participate in internships in any mode as determined by the employer, including in-person, online, or hybrid formats. Awdiz does not guarantee online interviews, work-from-home (WFH) roles, or remote internships. Candidates shall not refuse or decline any interview, job opportunity, or internship on the basis of interview mode, job location, work arrangement, or internship format. Any refusal or non-participation may result in the candidate being declared ineligible for further placement or internship opportunities, at the sole discretion of Awdiz.
• PDFs, presentations, recorded videos, and other required study materials will be shared in digital format after each class or module, as applicable. Access to such videos and study materials will be provided for a defined and time-bound period to encourage timely completion of assignments, assessments, and self-learning activities. Student access, usage, and progress may be monitored through the Awdiz LMS. All study materials are the intellectual property of Awdiz and are strictly for personal learning use only. Sharing, copying, recording, downloading, redistribution, or commercial use of these materials, in any form, is strictly prohibited and may result in disciplinary action, including termination from the program.
• If a student opts for an internship prior to placement, or if the Awdiz Placement Team determines that an internship is required to further enhance the candidate's technical skills, the candidate must be willing to relocate to the location assigned by Awdiz and be available to commence the internship immediately upon completion of training. Internships may be paid or unpaid, depending on the opportunity and employer terms. The candidate shall not decline or refuse the internship on the basis of stipend status, location, or any other reason, failing which the candidate may be declared ineligible for further placement services.
• Awdiz will make reasonable efforts to schedule interviews in virtual mode wherever possible, including for online or outstation candidates. However, if a client requires a face-to-face interview, the candidate must be physically available at the location assigned by Awdiz for a minimum period of sixty (60) days to participate in the placement process. Travel, accommodation, and related expenses during this period shall be the sole responsibility of the candidate. Availability at the assigned location does not guarantee a specific number of interviews, as interview opportunities depend on client requirements and hiring conditions. Failure to comply with these requirements may impact the candidate's placement eligibility.
• Candidates are required to attend all interviews arranged by Awdiz or its authorized placement partners. If a candidate is unable to attend a scheduled interview, prior written approval must be obtained from the Placement Manager via email. Valid justifications for non-attendance may include medical emergencies, officially scheduled examinations, or other exceptional circumstances supported by appropriate documentation. Missing two (2) or more interviews arranged by Awdiz without approved justification shall result in the candidate being declared ineligible for further placement services and interview opportunities.
• The Master Programs are offered as job-guaranteed packages; however, Awdiz does not commit to a fixed salary for any candidate. Offered compensation will be based on the role, company, market conditions, and candidate performance, and is generally expected to fall within a range of INR 2.0 LPA to INR 6.0 LPA. Salary discussions and negotiations are conducted directly between the candidate and the employer during the interview process. As part of the training, Awdiz provides guidance and preparation to help candidates approach salary discussions confidently and maximize their potential compensation for the offered role.
• If an employer specifies a fixed-duration internship prior to confirmation on permanent payroll, or includes a defined employment bond period in the offer letter, the candidate must be willing to accept such conditions and sign the required bond agreement. These conditions are common for fresher-level roles and form part of the employer's hiring policy. Declining a job offer on the basis of internship duration or bond requirements is not permitted and may result in the candidate being declared ineligible for further placement services. Any bond agreement, duration, or related obligations shall be strictly between the candidate and the employer, and Awdiz shall not be held responsible or liable for the terms, enforcement, or consequences arising from such agreements.
• Students must be willing to accept employment offers under direct payroll or third-party payroll arrangements, including roles involving client-site deployment. Candidates should be comfortable working with organizations of all sizes, including startups, service providers, multinational companies, banking and financial institutions, educational institutions, and other client-driven environments. Declining an offer based on payroll structure, company size, contract nature, work shifts, or deployment model shall not be permitted and may result in ineligibility for further placement services.
• Based on the course selected by the student, the job-guaranteed programs cover multiple topics designed to prepare candidates for a wide range of IT infrastructure and software development roles. Training duration typically ranges between four and a half (4.5) to eight (8) months, depending on the course, and will be clearly communicated to the student at the commencement of training. The placement and interview process may begin after completion of certain key modules, even if the full course curriculum has not yet been completed. Training for the remaining modules will continue in parallel with interviews to ensure that capable and job-ready candidates can begin their careers without unnecessary delay.
• Under Awdiz's Job Guarantee Programs, students are eligible for fresher-level roles relevant to the course enrolled. Job designations may vary across companies; however, if the offered role aligns with the skills and technologies covered in the training, the student is required to accept the offer. Refusal based solely on designation, employer type, or payroll model (direct or third-party) may result in disqualification from further placement services. Awdiz reserves the right to validate role alignment before enforcing this clause.


| Course | Details |
|---|---|
| **Networking and System Expert course** | As covers vast IT topics in various technologies of System, Server and Networking Ticketing Tool Monitoring Tool so student can be placed in different L1 roles like Desktop Support Engineer, IT Support Engineer, Server Administrator, Windows Admin, Server Engineer, NOC, Field Support Engineer, Technical Support Engineer, IT Engineer, Network Engineer, System Admin, IT Field Engineer, Trainee, Network Support Engineer and similar positions in IT Infra Division. |
| **Networking, System, and Cybersecurity course** | As this course covers an extensive set of modules including Networking Fundamentals, Windows/Linux Administration, Firewalls, Ticketing Tools, Monitoring Tools, and basic Cybersecurity concepts, students can be placed in multiple fresherlevel IT infrastructure and security-related roles. These roles include, but are not limited to: Network Engineer, System Administrator, IT Support Engineer, Desktop Support Engineer, Security Analyst - L1, SOC Analyst - Trainee, NOC Engineer, Windows/Linux Admin, IT Security Support, Technical Support Engineer, Network Support Engineer, Infrastructure Support Executive, Security Operations Intern, Helpdesk Engineer, IT Field Engineer and **Cybersecurity Analyst – Intern and similar positions in IT Infra Division**. |
| **Networking, System, and AWS Cloud course** | As this course delivers in-depth training on Networking, Windows/Linux Administration, Server & System Monitoring, Cloud Fundamentals, AWS Services (EC2, S3, IAM, VPC, etc.), and Ticketing Tools, students become eligible for various entry-level roles in IT Infrastructure and Cloud Support. These roles include, but are not limited to: Cloud Support Engineer – L1, AWS Cloud Administrator – Trainee, System Administrator, Network Engineer, Cloud Operations Associate, Infrastructure Support Engineer, Desktop Support Engineer, Server Admin, DevOps Support – Intern, NOC Engineer, Cloud Technical Support, IT Support Engineer, AWS Trainee Engineer and Cloud Helpdesk Engineer and similar positions in IT Infra Division. |
| **Full Stack Developer Course** | As this course at AWDIZ covers comprehensive topics across both Java Full Stack (Core Java, JDBC, Spring Boot, REST APIs, MySQL) and MERN Stack (MongoDB, Express.js, React.js, Node.js), along with essential front-end skills (HTML, CSS, JavaScript, Bootstrap) and version control (Git/GitHub), students become eligible for a broad range of fresher-level software development roles. These roles include, but are not limited to: Full Stack Developer, Java Developer, MERN Stack Developer, React Developer, Backend Developer (Java/Node.js), Frontend Developer, Web Developer, Application Developer, Software Engineer, UI Developer, API Developer, Software Development Intern, Trainee Software Engineer, Junior Full Stack Engineer and Graduate Engineer Trainee (GET) and similar positions in IT Development. |
| **Data Analytics and Data Science course** | As this course encompasses a broad curriculum including statistics, Excel, SQL, Python, Power BI, Tableau, Machine Learning, and data visualization tools, students can be placed across various fresher-level analytical and data-centric roles in IT and non-IT companies. These include, but are not limited to: Data Analyst, Business Analyst, Data Science Intern, Junior Data Scientist, MIS Analyst, Reporting Analyst, BI Developer, Research Analyst, SQL Analyst, Python Developer (Data Focused), Data Engineer - Intern, Associate Analyst, Insight Analyst, Decision Science Analyst, Analytics Executive and ML Trainee and similar positions in IT Development. |


• Once a student is shortlisted after final discussions or receives a job offer, the opportunity must be accepted. Declining such an opportunity will result in immediate cancellation of placement services, and the student will be required to seek re-admission by paying the full course fee again to re-enter the placement process.
• Awdiz shall not be held responsible if a candidate voluntarily resigns from a company or is terminated by the employer due to performance issues, misconduct, or violation of company policies. Once a candidate accepts a job offer from any company, whether secured independently or through Awdiz, the candidate shall not be eligible for any further placement assistance or fee refunds under the Awdiz 100% Job Guarantee Program.
• Post-placement support of up to thirty (30) days will be provided to students who have completed full fee payment and have met the minimum eligibility criteria of 85% attendance and 85% mock assessment scores, as per Awdiz policy. Such support shall be extended only under specific circumstances, including layoffs or downsizing, offer revocation, assignment to a non-IT role, unethical working conditions, or salary terms not being honoured, provided that all such claims are supported by valid legal or official documentation
• Post-placement support shall not be extended to candidates who are terminated or exit employment due to misconduct, behavioural or disciplinary issues, absconding from duty, inadequate technical competency, irregular attendance, voluntary resignation, mismatch in educational or experience documents, unrealistic salary expectations, inability to manage job-related stress, dissatisfaction with workplace culture, or unwillingness to relocate or work in rotational shifts.
• Once a candidate has availed a second job opportunity through Awdiz that meets the eligibility criteria for post-placement support, the candidate's training and placement services shall be deemed complete. Thereafter, the candidate shall not be eligible to re-approach Awdiz for any further placement assistance or training repetitions under the program.
• Students pursuing regular degree programs shall become eligible for participation in Awdiz Job Guarantee Programs only after a minimum period of three (3) months from the completion of their graduation. If a candidate chooses to pursue higher education at any stage after enrolment, the Job Guarantee agreement shall stand cancelled, and the candidate shall not be eligible for any training repetitions, placement support, or fee refunds under the program.

• Awdiz reserves the right to use a candidate's placement-related information, name, photographs, images, and videos for promotional, marketing, branding, and website collateral purposes, irrespective of whether the placement was secured through Awdiz or independently by the candidate. In the event that a candidate declines to provide a testimonial after securing employment, Awdiz shall still be entitled to use such placement-related details and visual content without requiring any additional consent. No confidential or sensitive personal information shall be disclosed as part of such usage.
• For Awdiz to provide placement assistance, the learner must successfully complete the course in accordance with Awdiz's prescribed academic standards and clear all mandatory career development activities, assignments, and evaluations as defined in the course curriculum or as assigned by the Awdiz career or placement team. In addition, the learner must have successfully completed their formal graduation. Learners who have not completed their graduation shall not be eligible to participate in placement services offered by Awdiz.
• All courses offered by Awdiz are governed by a non-refundable and non-transferable policy. Awdiz does not provide refunds under any circumstances once a candidate has been admitted into a course. Upon payment of the course fee and confirmation of admission, the candidate is deemed to have committed to completing the course. Candidates are advised to fully understand the course structure, requirements, and obligations prior to enrolment and fee payment. Any doubts or clarifications must be addressed with the Awdiz Admissions Team before making the payment, as post-admission requests for refunds, transfers, or cancellations shall not be entertained.
• Under the Awdiz 100% Job Guaranteed Program, if a student is unable to secure placement after attending the minimum number of interviews specified in this agreement, the student must be willing to accept job offers at any location and across suitable entry-level roles, irrespective of specialization or qualification alignment. This provision enables Awdiz to fulfil its commitment to 100% placement support for enrolled candidates. The 100% Job Guarantee implies that Awdiz will continue to facilitate interview opportunities until the student is placed or receives a minimum job offer with a compensation range of INR 12,000 to INR 15,000 CTC. Acceptance of such an offer shall be mandatory to satisfy the job guarantee obligation under this program.
• Awdiz shall not be held responsible or liable for any delay or inability to provide job placement opportunities arising from economic downturns, hiring freezes, pandemics, government restrictions, or any other events beyond the reasonable control of Awdiz.
• Learners are required to respond to all interview- or job-offer-related communications from Awdiz or its authorized representatives within twenty-four (24) hours, clearly confirming acceptance or rejection, as applicable. Such communication may be sent via email, phone call, messaging platforms including WhatsApp, or through the Awdiz LMS. Failure to respond within the stipulated timeframe may result in suspension or cancellation of placement eligibility and support.
• Awdiz reserves the right to make changes to course fees, office locations, trainers, course content, batch schedules, timings, and batch start dates based on academic, operational, or business requirements. In the event of any such changes, Awdiz shall make reasonable efforts to inform students within an appropriate timeframe to ensure continuity of training.
• Students must strictly adhere to the payment schedule agreed upon at the time of admission. Any delay beyond the due date shall result in the following actions:
  - Immediate suspension of access to the Awdiz LMS, recorded lectures, assessments, test portals, and participation in classroom or online sessions.
  - If outstanding dues remain unpaid for more than fifteen (15) days, Awdiz reserves the right to terminate the student's admission without any refund.
  - To resume training after suspension, the student must clear all pending dues and may be required to pay a reactivation fee of INR 2,000, subject to approval by the Centre Manager.
  - During any period of payment default or suspension, the student's placement eligibility and placement timelines shall remain paused and shall resume only after full clearance of dues and reinstatement of training access.
• Students opting for EMI (Equated Monthly Instalment) or instalment-based payment plans are required to make all payments on or before the respective due dates without fail. Any missed, delayed, or bounced EMI shall attract the following consequences:
  - Immediate suspension of access to all training sessions, the Awdiz LMS, assessments, recorded content, and placement-related services until all outstanding dues are cleared.
  - If two (2) or more EMIs are missed, the student shall be treated as a defaulter, and the entire remaining course fee shall become immediately payable in a single lump sum.
  - In the event of bounced EMIs, failed auto-debits, or payment defaults, the student shall be solely responsible for any penalties, late fees, legal action, recovery proceedings, or notices initiated by the financing partner, NBFC, or bank.
  - Awdiz shall not be held responsible or liable for any legal consequences, reputational impact, credit score deterioration, or third-party actions arising due to the student's financial default with the EMI provider or bank.
  - Continued non-payment for a period exceeding thirty (30) days shall result in permanent cancellation of admission and Job Guarantee services, without any refund.

  In the event of default, delay, or non-payment of fees, including EMI or loan repayments to Awdiz, its NBFC/loan partners, or through NACH or any other approved payment mode, Awdiz reserves the right to restrict or revoke the participant's access to the learning platform, training sessions, placement services, and related facilities. In such cases, the participant shall not be eligible for any course completion certificate.
• If a learner fails to demonstrate sincere, consistent, and genuine efforts toward securing employment, refuses to accept a job offer, or after accepting an offer fails to join or continue in the employment for any reason whatsoever, including roles requiring relocation to designated locations or any other cities as prescribed by Awdiz from time to time, Awdiz reserves the right to suspend or permanently withdraw placement support and related services.
• Awdiz retains sole and absolute discretion to introduce, modify, or withdraw scholarships, discounts, or special schemes from time to time for selected categories of participants, for specific periods, or under such terms and conditions as it may deem appropriate.
• The student agrees to fully indemnify and hold harmless Awdiz Institute from and against any and all claims, losses, liabilities, damages, costs, or expenses (including reasonable legal fees) arising out of or in connection with any act, omission, misrepresentation, or breach during the training and placement duration at Awdiz by the candidate.
• Awdiz reserves the sole and absolute right to approve or reject any request for batch change and/or adjustment. In the event of any violation of the code of conduct or other exceptional circumstances, Awdiz may take such action as it deems appropriate, including but not limited to denial of the request or reassignment, in accordance with its internal policies.
• Awdiz Management reserves the right, at its sole discretion, to modify, amend, update, or revise the rules, policies, terms, course structure, content, curriculum, and syllabus at any time based on market conditions, industry demand, academic relevance, or operational requirements. Awdiz may also add to or update these Terms and Conditions from time to time. Any such changes shall be communicated through official channels including, but not limited to, the Awdiz website, official email communication, LMS notifications, or other authorized modes. All amendments shall take effect immediately upon notification. Continued access to or use of Awdiz's services, training programs, platform, website, or LMS after such updates shall be deemed as unconditional acceptance of the revised Terms and Conditions. Any digital acknowledgment, confirmation via email or LMS, or continued usage shall constitute legally binding consent, equivalent to a physical signature.
• If a learner is rejected by three (3) or more companies due to inadequate performance, negative recruiter feedback, or lack of preparedness, Awdiz reserves the right to temporarily limit or pause further interview opportunities. Placement support shall resume only after the learner completes additional training, corrective measures, or preparation as prescribed by Awdiz.
• Failure to attend a scheduled interview without prior written approval from Awdiz shall be treated as a "No Show" and may result in immediate suspension or restriction of placement services.

• Learners must demonstrate willingness and availability for the following, as required by employers:
  - Support roles, night shifts, or rotational shift schedules
  - Internship opportunities, including potential conversion to full-time employment

• Fee Payment & Continuation of Training: The student acknowledges that payment of fees must be made strictly as per the agreed schedule. In case of delay or default, the institute reserves the right to:
  - Suspend training access (online/offline)
  - Apply late payment penalties
  - Withhold certificates, assessments, or placement services
  - until all outstanding dues are cleared.
• No Liability for Emotional Distress Due to Fee or Placement Issues: The student agrees that Fee-related actions (late fees, penalties, suspension, termination) and Placement timelines, interview outcomes, or delays may cause disappointment but shall not be considered mental harassment, emotional abuse, or exploitation by the institute, its staff, trainers, placement team, management, or directors.

• Self-Harm & Threat Disclaimer: The institute, its founders, directors, employees, placement officers, trainers, and representatives shall not be held responsible or liable for:
  - Any self-harm, suicide attempt, threat, or emotional reaction by the student
  - Any statements, messages, or allegations made by the student blaming the institute or its staff for such actions
  - The student confirms that all decisions related to mental health, emotional well-being, and personal actions remain solely their own responsibility.
Any attempt to threaten, blackmail, or pressure the institute using self-harm or suicide claims shall be treated as misconduct and may result in immediate termination without refund.
• Jurisdiction & Legal Protection: Any dispute, claim, or legal proceeding arising out of or in connection with this admission, training, or services shall be subject exclusively to the jurisdiction of the competent courts in Mumbai. The Institute's official records, including but not limited to written policies, payment receipts, LMS reports, emails, call records, SMS, and WhatsApp communication logs, shall be deemed valid, admissible, and conclusive legal evidence.

• Harassment & False Allegation Protection:  The student agrees that:
  - Legitimate enforcement of institute policies does not amount to harassment
  - Making false, exaggerated, or defamatory claims against staff or management—verbally, in writing, or on social media—will be treated as a serious disciplinary violation
  The institute reserves the right to initiate legal action in such cases.

• Jurisdiction & Legal Protection: Any dispute, claim, or legal proceeding arising out of or in connection with this admission, training, or services shall be subject exclusively to the jurisdiction of the competent courts in Mumbai. The Institute's official records, including but not limited to written policies, payment receipts, LMS reports, emails, call records, SMS, and WhatsApp communication logs, shall be deemed valid, admissible, and conclusive legal evidence.

Any actions taken by Awdiz in accordance with the rules, policies, terms, and procedures set forth in this agreement, including but not limited to enforcement of eligibility criteria, payment compliance, training discipline, placement conditions, administrative decisions, or legal remedies, shall not be construed as harassment, coercion, discrimination, emotional abuse, or unfair treatment. Such actions are undertaken solely to uphold academic standards, operational integrity, financial discipline, regulatory compliance, and placement effectiveness. The student acknowledges and agrees that compliance with these terms is mandatory and that enforcement of the same does not give rise to any claim, grievance, or liability against Awdiz, its management, staff, trainers, or representatives, thereby concluding this agreement in full and final understanding.

**Note:** **Complete fee payment is mandatory to apply for interviews. Candidate with pending fees (for any reason) will strictly not be allowed for any interviews arranged by Awdiz. Center Manager approval for complete full payment needs to be submitted to placement team for initiating interviews after training.**

**Kindly take admission at AWDIZ if the clauses of all the terms and conditions mentioned above are satisfying to you. Once you are admitted to our institute means you have read all our terms and conditions and you are agreeing with it.**

I/We hereby declare that the information given by me on the Online/Offline Registration / Application Form etc. is correct to the best of my knowledge and belief. I/We understand that in the event of any information found to be incorrect or false, my admission may be cancelled.

I/We the Father/Mother/ or the student hereby severally and jointly declare that I / we have read and understood all the clauses contained in the Declaration on the Registration and agree to abide by them without any reservation or ambiguity and I/We have taken a print of all the terms and conditions for my future reference.

**NOTE: This contract is valid for a period of 12 Months from the date of signing the contract.**
**Any legal matter/dispute is subject to Mumbai Jurisdiction only.**

**AWDIZ Office Address 1:** 2nd Floor, Vashi Plaza Building, Office no. 421A, A Wing, Sector 17, Vashi, Navi Mumbai, Maharashtra 400703
**Awdiz Office Address 2:** Ground floor, A 791, KC Marg, next to 81 Aureate, Reclamation, Bandra West, Mumbai, Maharashtra 400050

**Note:** Kindly submit **2 Passport Size Photographs, One Digital Photograph for online records, PAN Card and Aadhar/ Driving License** photocopy along with signed copy of this agreement.`;

const DEFAULT_TRAINING_ONLY_TNC =
  `Fees once paid will not be refunded or adjusted under any circumstances.
By signing this document, you acknowledge that you have received and agreed to learn the syllabus shared by Awdiz.`;

const DEFAULT_JOB_ASSISTANCE_TNC = `Students Agreement Copy – Awdiz Job Assistance Program

This Agreement applies to all candidates enrolling in Awdiz Job Assistance Programs, where the primary focus is on skill development, interview preparation, career guidance, and structured placement assistance only.

By enrolling in this program, the student acknowledges and agrees that Awdiz only provides job assistance and placement support, and the final outcome depends entirely on the student's performance, eligibility, interview clearance, conduct, and the hiring company's selection criteria.

By enrolling, the student agrees to follow all rules, policies, academic requirements, and professional standards defined by Awdiz.

Program Objective

The Job Assistance Program is designed to:
• Build strong technical and practical skills
• Prepare students for real-world interviews
• Provide structured placement assistance
• Improve employability through continuous training, guidance, and support

Awdiz supports students through resume guidance, mock interviews, interview coordination, job opportunity sharing, and general career support. Final job selection depends on the student's own merit and the employer's decision.

Terms & Conditions – Job Assistance Program

1. Nature of Program

This is strictly a Job Assistance Program.

Awdiz shall provide support in the form of:
• Technical training
• Practical skill development
• Resume building
• Mock interviews
• Soft skills preparation
• Interview scheduling support
• Sharing of relevant job opportunities

Awdiz shall not be held responsible for guaranteeing job placement, salary level, role preference, company preference, location preference, or timeline of selection.

2. Training & Learning

Training may be delivered through:
• Classroom sessions
• Online sessions
• Hybrid mode
• Recorded sessions
• LMS-based learning support

LMS access may be provided for tracking and managing:
• Attendance
• Assignments
• Assessments
• Mock interviews
• Interview preparation activities

3. Attendance & Performance

Students are strongly encouraged to maintain at least 80% attendance, though attendance alone does not guarantee interview opportunities or selection.

Students are expected to:
• Attend classes regularly
• Complete assignments on time
• Participate in mock interviews
• Attend soft skills and interview preparation sessions
• Maintain seriousness and consistency throughout the program

Awdiz reserves the right to decide whether a student is sufficiently prepared and eligible to be considered for placement assistance opportunities.

Important Note: Better performance, stronger skills, and professional discipline directly improve the student's chances of receiving interview opportunities and getting selected. Poor performance may reduce or delay placement assistance.

4. Assessments & Eligibility

Regular tests, assignments, practical evaluations, mock interviews, and internal assessments may be conducted during the program.

Awdiz reserves the right to determine whether a student is interview-ready and eligible for job opportunities based on:
• Technical knowledge
• Practical performance
• Communication skills
• Mock interview performance
• Assignment completion
• Professional conduct
• Overall readiness for hiring

Students who are not found ready, eligible, or suitable for interviews may not be forwarded to hiring companies until improvement is observed.

5. Placement Assistance Scope

Awdiz may provide the following placement assistance support:
• Resume building support
• Profile improvement guidance
• Mock interview practice
• Soft skills support
• Interview scheduling support
• Sharing of job openings and company requirements
• General career guidance

Placement assistance is limited to support activities only. Awdiz does not promise any minimum number of interviews, job calls, job offers, or joining confirmations.

The number of interviews or job opportunities shared depends on:
• Student performance
• Student eligibility
• Student readiness
• Market conditions
• Employer requirements
• Open positions available at the time

6. Candidate Responsibility

The student is fully responsible for making the best use of the assistance provided by Awdiz.

The student must:
• Actively apply to jobs shared by Awdiz
• Attend all scheduled interviews on time
• Respond to calls, emails, and messages within 24 hours
• Maintain professional behaviour with Awdiz staff and employers
• Be honest in communication and documentation
• Prepare sincerely for interviews
• Remain flexible regarding entry-level opportunities

Failure to do so may affect, delay, suspend, or discontinue placement assistance support at Awdiz's sole discretion.

7. Job Assistance Only

The student clearly understands, acknowledges, and agrees that this program is a Job Assistance Program only.

Awdiz provides Job Assistance only, which may include resume support, interview preparation, mock interviews, job opportunity sharing, and interview scheduling support. Under no circumstances shall this program be interpreted as a job guarantee, employment guarantee, or assured placement commitment.

The student further understands and accepts that:
• Awdiz does not promise assured placement
• Student is responsible if they are not selected by any company
• Awdiz is not responsible for interview rejection, delayed hiring, lack of openings, company hiring freezes, or employer-side decisions
• Job Assistance will depend on the student's performance, readiness, eligibility, and interview qualification

Final selection depends entirely on:
• The student's technical and practical capability
• Communication skills and interview performance
• Behaviour, discipline, and professionalism
• Employer assessment criteria
• Employer hiring requirements and business decisions

Awdiz's responsibility is limited strictly to providing Job Assistance only, and not guaranteed employment or assured placement.

8. Job Acceptance & Opportunity Fit

Students are expected to seriously consider job opportunities shared by Awdiz, especially entry-level opportunities relevant to their course and skill set.

Awdiz shall not be responsible for:
• Student salary expectations
• Preferred company choices
• Preferred job title
• Preferred location
• Preferred shift timings
• Rejection of available opportunities by the student

Refusal to attend or accept suitable opportunities may impact future placement assistance.

9. Placement Timeline

Placement assistance may begin during or after training, depending on the student's readiness and hiring market conditions.

No fixed placement timeline is promised or guaranteed by Awdiz.

Awdiz shall not be held responsible for any delay in interviews, job calls, or final selection.

10. Internship Opportunities

Awdiz may share internship opportunities from time to time, whether paid or unpaid, based on availability and employer requirements.

Internship opportunities are also part of job assistance support only and do not guarantee permanent employment.

11. Fees & Payment Policy

All program fees paid to Awdiz are non-refundable and non-transferable under any circumstances, unless otherwise stated in writing by management.

Delay or default in payment may result in:
• LMS access restriction
• Suspension of training access
• Withholding of support services
• Delay or restriction in placement assistance

Full fee payment compliance may be required before completion formalities or continued support.

12. Batch Change Policy

Batch changes are allowed only in valid and exceptional cases, subject to management approval.

Awdiz may apply administrative charges for any approved batch transfer.

13. Code of Conduct

Students are expected to maintain proper discipline, professionalism, and respectful conduct throughout the program.

Any misconduct, misbehaviour, false commitments, abusive language, indiscipline, or actions harming Awdiz's reputation may lead to:
• Suspension
• Termination from training/support
• Permanent discontinuation of placement assistance
• No refund of fees

14. Course Completion

The course shall be considered completed only when:
• Training modules are completed
• Required assessments are attempted as applicable
• All dues and fees are fully paid

Completion of the course does not mean job placement is guaranteed.

15. Limitation of Liability

Awdiz shall not be held liable for:
• No job offer being received
• Delay in receiving interviews
• Delay in hiring processes
• Rejection by companies
• Market slowdown
• Lack of openings
• Student not being interview-ready
• Student failing interviews
• Student refusing opportunities
• Salary/package lower than student expectations
• Role, company, or location mismatch with student preference

Awdiz's role is limited strictly to training and placement assistance support, and not guaranteed employment.

16. Promotional Usage

Awdiz may use student-related information such as:
• Name
• Photograph
• Course details
• Placement or internship details
• Testimonials or reviews

for purposes including:
• Marketing
• Branding
• Social media
• Website promotion
• Institutional communication

unless otherwise restricted by written agreement.

17. Jurisdiction

All disputes, claims, and matters arising out of this agreement shall be subject exclusively to the jurisdiction of the courts of Mumbai, Maharashtra.

Important Notes

Note: Complete fee payment is mandatory to apply for interviews. Candidate with pending fees (for any reason) will strictly not be allowed for any interviews arranged by Awdiz. Center Manager approval for complete full payment needs to be submitted to placement team for initiating interviews after training.

Kindly take admission at AWDIZ if the clauses of all the terms and conditions mentioned above are satisfying to you. Once you are admitted to our institute means you have read all our terms and conditions and you are agreeing with it.

I/We hereby declare that the information given by me on the Online/Offline Registration / Application Form etc. is correct to the best of my knowledge and belief. I/We understand that in the event of any information found to be incorrect or false, my admission may be cancelled.

I/We the Father/Mother/ or the student hereby severally and jointly declare that I / we have read and understood all the clauses contained in the Declaration on the Registration and agree to abide by them without any reservation or ambiguity and I/We have taken a print of all the terms and conditions for my future reference.

NOTE: This contract is valid for a period of 12 Months from the date of signing the contract.

Any legal matter/dispute is subject to Mumbai Jurisdiction only.

AWDIZ Office Address 1: 2nd Floor, Vashi Plaza Building, Office no. 421A, A Wing, Sector 17, Vashi, Navi Mumbai, Maharashtra 400703

Awdiz Office Address 2: Ground floor, A 791, KC Marg, next to 81 Aureate, Reclamation, Bandra West, Mumbai, Maharashtra 400050

Note: Kindly submit 2 Passport Size Photographs, One Digital Photograph for online records, PAN Card and Aadhar/ Driving License photocopy along with signed copy of this agreement.`;

/* ===== Status banner ===== */
function statusBanner(doc, status) {
  if (!status) return;
  const map = {
    approved: { color: "#16a34a", text: "ADMISSION APPROVED" },
    pending:  { color: "#dc2626", text: "ADMISSION PENDING" },
    review:   { color: "#d97706", text: "ADMISSION UNDER REVIEW" },
  };
  const cfg = map[String(status).toLowerCase()] || map.pending;

  const x = MARGIN, w = CONTENT_W, h = 28;
  ensureSpace(doc, h + 4);
  const y = doc.y;

  doc.save()
    .rect(x, y, w, h).fill("#F8FAFC")
    .fillColor(cfg.color).font("Helvetica-Bold").fontSize(12)
    .text(cfg.text, x, y + 7, { width: w, align: "center" })
    .restore();

  doc.moveDown(0.5);
}

/* ===================  T&C helpers (UPDATED)  =================== */
function drawStyledLine(doc, text, opts = {}) {
  const { width = CONTENT_W, align = "left", lineGap = 3 } = opts;

  // Set font first before calculating height
  doc.font("Helvetica").fontSize(11);
  
  // Calculate actual height needed for this text
  const textHeight = doc.heightOfString(text, { width, lineGap });
  const totalHeight = Math.max(textHeight + 8, 24);
  
  ensureSpace(doc, totalHeight);

  if (!text.includes("**") && /[^/]+:\s*\S/.test(text)) {
    const m = text.match(/^([^:]+:)(\s*)(.*)$/);
    if (m) {
      const [, label, sp, rest] = m;
      doc.font("Helvetica-Bold").fontSize(11).text(label, { width, continued: true, align, lineGap });
      doc.font("Helvetica").fontSize(11).text(sp + rest, { width, align, lineGap });
      doc.moveDown(0.2);
      return;
    }
  }

  const parts = text.split(/(\*\*[^*]+?\*\*)/g).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const isBold = p.startsWith("**") && p.endsWith("**");
    const clean = isBold ? p.slice(2, -2) : p;
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(11)
       .text(clean, { width, align, lineGap, continued: i !== parts.length - 1 });
  }
  doc.moveDown(0.2);
}

function drawBullet(doc, raw, level = 0) {
  const text = raw.replace(/^[-•]\s*/, "").trim();
  const bulletX = MARGIN + level * 16;
  const textX   = bulletX + 12;
  const usableW = CONTENT_W - (textX - MARGIN);

  // Set font first before calculating height
  doc.font("Helvetica").fontSize(11);
  
  // Calculate actual height needed for this bullet text
  const textHeight = doc.heightOfString(text, { 
    width: usableW, 
    lineGap: 2
  });
  const totalHeight = Math.max(textHeight + 4, 20);

  ensureSpace(doc, totalHeight);
  const y0 = doc.y;

  doc.font("Helvetica").fontSize(12).text("•", bulletX, y0, { width: 10, continued: false });

  doc.x = textX; doc.y = y0;
  drawStyledLine(doc, text, { width: usableW, align: "left", lineGap: 2 });
  doc.moveDown(0.15);
}

/* ---------- Markdown Table Parsing (kept) ---------- */
function parseMarkdownTable(lines, startIdx) {
  const tableLines = [];
  let i = startIdx;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln || !ln.trim().startsWith("|")) break;
    tableLines.push(ln.trim());
    i++;
  }
  if (tableLines.length < 2) return { next: startIdx, header: [], rows: [] };

  const splitRow = (row) =>
    row
      .replace(/^\|/, "").replace(/\|$/, "")
      .split("|").map(c => c.trim());

  const header = splitRow(tableLines[0]);
  let bodyStart = 1;
  if (/^\|?\s*:?-{3,}/.test(tableLines[1])) bodyStart = 2;

  const rows = tableLines.slice(bodyStart).map(r => splitRow(r));
  return { next: i, header, rows };
}

/* ---------- NEW: Full-page, bordered Course|Details table ---------- */
function drawTCFullTable(doc, header, rows) {
  const x = MARGIN;
  const w = CONTENT_W;
  const pad = 10;

  // ~35% left column (looks like your reference)
  const colW1 = Math.floor(w * 0.35);
  const colW2 = w - colW1;

  const pageBottom = () => doc.page.height - MARGIN;

  // Header band (inside table)
  const drawHeader = () => {
    ensureSpace(doc, 25);
    const hY = doc.y;
    doc.save().rect(x, hY - 2, w, 26).fill("#f2f2f2").restore();
    doc.font("Helvetica-Bold").fontSize(11)
      .text(header[0] || "", x + pad, hY + 2, { width: colW1 - pad })
      .text(header[1] || "", x + pad + colW1, hY + 2, { width: colW2 - pad });
    doc.moveDown(0.5);
    return hY - 2; // return top for outer border
  };

  // open first page
  let tableTopY = drawHeader();

  const writeRow = (course, details) => {
    const y0 = doc.y;

    // Set font before calculating heights
    doc.font("Helvetica").fontSize(11);

    const h = Math.max(
      doc.heightOfString(course,  { width: colW1 - pad, lineGap: 2 }),
      doc.heightOfString(details, { width: colW2 - pad, lineGap: 2 })
    ) + 4;

    // page break BEFORE drawing the row (avoid split)
    // Only add new page if row won't fit at all, otherwise continue on same page
    if (y0 + h + 20 > pageBottom()) {
      // close current page border
      const endY = y0 + 2;
      doc.save().strokeColor("#bfbfbf")
        .rect(x, tableTopY, w, endY - tableTopY).stroke()
        .moveTo(x + colW1, tableTopY).lineTo(x + colW1, endY).stroke()
        .restore();
      doc.addPage();
      tableTopY = drawHeader();
    }

    const y = doc.y;

    // left cell (course) — bold if wrapped with ** **
    const isBold = /^\*\*.*\*\*$/.test(course);
    const cleanCourse = isBold ? course.replace(/^\*\*|\*\*$/g, "") : course;
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fontSize(11)
       .text(cleanCourse, x + pad, y, { width: colW1 - pad, lineGap: 2 });

    // right cell (details) — supports **bold** spans
    const parts = String(details).split(/(\*\*[^*]+?\*\*)/g).filter(Boolean);
    doc.x = x + pad + colW1; doc.y = y;
    parts.forEach((p, idx) => {
      const b = p.startsWith("**") && p.endsWith("**");
      const txt = b ? p.slice(2, -2) : p;
      doc.font(b ? "Helvetica-Bold" : "Helvetica").fontSize(11)
         .text(txt, { width: colW2 - pad, lineGap: 2, continued: idx !== parts.length - 1 });
    });

    // row bottom line
    const y1 = Math.max(doc.y, y + h);
    doc.save().strokeColor("#d9d9d9").moveTo(x, y1).lineTo(x + w, y1).stroke().restore();
    doc.y = y1 + 2;
  };

  rows.forEach(r => writeRow(r[0] || "", r[1] || ""));

  // close final border on the last page
  const finalBottom = doc.y + 2;
  doc.save().strokeColor("#bfbfbf")
    .rect(x, tableTopY, w, finalBottom - tableTopY).stroke()
    .moveTo(x + colW1, tableTopY).lineTo(x + colW1, finalBottom).stroke()
    .restore();
}

/** ------- Helpers to force T&C to Only Table when provided ------- */
function buildTableMarkdownFromArray(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  let out = "| Course | Details |\n|---|---|\n";
  rows.forEach(r => {
    const course  = (typeof r === "object" && !Array.isArray(r)) ? (r.course ?? "") : (Array.isArray(r) ? (r[0] ?? "") : "");
    const details = (typeof r === "object" && !Array.isArray(r)) ? (r.details ?? "") : (Array.isArray(r) ? (r[1] ?? "") : "");
    out += `| ${String(course).trim()} | ${String(details).trim()} |\n`;
  });
  return out;
}
function normalizeTableMarkdown(md) {
  if (!md) return "";
  return String(md).trim()
    .replace(/^\s*-{3,}\s*\n?/, "")
    .replace(/\n?\s*-{3,}\s*$/, "")
    .trim();
}

/** Render multi-line T&C with bullets + bold segments + markdown table hook */
function renderTerms(doc, tcText) {
  // Don't trim lines here - we need to detect leading spaces for nested bullets
  const rawLines = (tcText || "").split("\n").map(s => s.replace(/\r/g, ""));

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i];
    
    // Count leading spaces to determine nesting level
    const leadingSpaces = rawLine.match(/^(\s*)/)?.[1]?.length || 0;
    const line = rawLine.trim();
    const nestingLevel = Math.floor(leadingSpaces / 2); // 2 spaces = 1 level

    if (!line) { 
      // Check if we need a page break even for empty lines
      ensureSpace(doc, 8);
      doc.moveDown(0.25); 
      continue; 
    }

    // Heading that precedes a table (kept compatible)
    if (/^#{2,3}\s*\**Eligible Fresher Roles.*\**\s*$/i.test(line)) {
      ensureSpace(doc, 30);
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(14).text(line.replace(/^#+\s*/, "").replace(/\*\*/g, ""), { align: "left" });
      doc.font("Helvetica").fontSize(12).moveDown(0.3);

      const parsed = parseMarkdownTable(rawLines, i + 1);
      if (parsed.rows.length) {
        drawTCFullTable(doc, parsed.header, parsed.rows);  // ✅ full-page bordered table
        i = parsed.next - 1;
        continue;
      }
    }

    // A table that starts immediately
    if (line.startsWith("|")) {
      const parsed = parseMarkdownTable(rawLines, i);
      if (parsed.rows.length) {
        drawTCFullTable(doc, parsed.header, parsed.rows);  // ✅ full-page bordered table
        i = parsed.next - 1;
        continue;
      }
    }

    // bullets (with nesting support) or normal text
    if (/^[-•]\s+/.test(line)) {
      drawBullet(doc, line, nestingLevel);
    } else {
      drawStyledLine(doc, line, { width: CONTENT_W, align: "left", lineGap: 2 });
    }
  }
}
/* ===================  /T&C helpers  =================== */

/* ---------------------- main PDF --------------------------- */
export async function generateAdmissionPDF(payload, opts = {}) {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on("data", c => chunks.push(c));
    doc.on("end",  () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Check course flags - PRIORITY: Job Assistance > Bootcamp > Training Only > Job Guarantee
  const hasJobAssistance = payload?.course?.jobAssistance === true;
  const hasBootcamp = payload?.course?.bootcampTraining === true;
  const hasTrainingOnly = payload?.course?.trainingOnly === true;
  const dbTcType = payload?.tc?.type;

  // Priority: job-assistance > bootcamp > training-only > job-guarantee
  let tcType = dbTcType || "job-guarantee"; // default
  if (hasJobAssistance) tcType = "job-assistance";
  else if (hasBootcamp) tcType = "bootcamp";
  else if (hasTrainingOnly) tcType = "training-only";

  const isJobAssistance = tcType === "job-assistance";
  const isBootcamp = tcType === "bootcamp";
  const isTrainingOnly = tcType === "training-only";

  console.log("[PDF] Final tcType:", tcType, "JobAssistance:", hasJobAssistance, "Bootcamp:", hasBootcamp, "TrainingOnly:", hasTrainingOnly);

  // ✅ force "review" → "pending"
  let status = (opts.status || payload?.status || payload?.statusBanner || "")
    .toString()
    .toLowerCase();
  if (status === "review") status = "pending";

  // Logo (optional) - First page (center)
  let logoBuf = null;
  if (process.env.AWDIZ_LOGO_URL) {
    logoBuf = await toImageBuffer(process.env.AWDIZ_LOGO_URL);
    if (logoBuf) { doc.image(logoBuf, MARGIN + CONTENT_W/2 - 50, doc.y, { fit: [100, 60] }); doc.moveDown(3.5); }
  }

  // Add small logo to upper left corner of every page after the first
  if (logoBuf) {
    doc.on('pageAdded', () => {
      // Draw small logo in upper left corner (page 2 onwards)
      doc.image(logoBuf, MARGIN, MARGIN - 28, { fit: [45, 30] });
    });
  }

  // Add center watermark to every page (including first page)
  let watermarkBuf = null;
  if (process.env.AWDIZ_CENTER_WATERMARK_URL) {
    watermarkBuf = await toImageBuffer(process.env.AWDIZ_CENTER_WATERMARK_URL);
  }
  
  if (watermarkBuf) {
    const drawCenterWatermark = () => {
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const watermarkW = 300;
      const watermarkH = 300;
      const x = (pageWidth - watermarkW) / 2;
      const y = (pageHeight - watermarkH) / 2;
      
      doc.save()
        .opacity(0.05)
        .image(watermarkBuf, x, y, { width: watermarkW, height: watermarkH })
        .restore();
    };
    
    // Draw on first page
    drawCenterWatermark();
    
    // Draw on all subsequent pages
    doc.on('pageAdded', () => {
      drawCenterWatermark();
    });
  }
  let admissionTypeLabel = "";
  if (isTrainingOnly) {
    admissionTypeLabel = "AWDIZ Admission Form – Training Program";
  } else if (isBootcamp) {
    admissionTypeLabel = "AWDIZ Admission Form – Bootcamp Training Program";
  } else if (isJobAssistance) {
    admissionTypeLabel = "AWDIZ Admission Form – Job Assistance Program";
  } else {
    admissionTypeLabel = "AWDIZ Admission Form – Job Guarantee Program";
  }
  heading(doc, admissionTypeLabel);

  if (status) statusBanner(doc, status);

  if (isTrainingOnly) {
    noticeBox(doc, "This admission is for Training-only (No Job Guarantee).");
  }

  const P   = payload.personal || {};
  const C   = payload.course   || {};
  const ID  = payload.ids      || {};
  const CTR = payload.center   || {};

  /* ---------- Personal ---------- */
  await sectionBox(doc, "Personal Information", async (area) => {
    twoColGrid(doc, area, [
      { label: "Mr/Ms", value: `${keep(P.salutation)} ${keep(P.name)}`.trim() },
      { label: "Son/Daughter/Wife of Mr", value: keep(P.fatherOrGuardianName) },

      { label: "Address", value: keep(P.address) },
      { label: "Parent's Mobile", value: keep(P.parentMobile) },

      { label: "Student’s Mobile", value: keep(P.studentMobile) },
      { label: "WhatsApp Mobile", value: keep(P.whatsappMobile) },

      { label: "Email ID", value: keep(P.email) },
      { label: "", value: "" },
    ], { labelRatio: 0.42 });
  });

  /* ---------- Course ---------- */
  await sectionBox(doc, "Course Details", async (area) => {
    const admissionTypeValue = isBootcamp ? "Bootcamp Training Program" : (isTrainingOnly ? "Training-only (No Guarantee)" : (isJobAssistance ? "Job Assistance Program" : "Job Guarantee Program"));
    const rows = [
      { label: "Admission Type", value: admissionTypeValue },
      { label: "Course Enrolled", value: keep(C.name) },
      { label: "Reference (Friend/Colleague/Relative)", value: keep(C.reference) },
    ];
    if (isTrainingOnly || C.trainingOnlyCourse) {
      rows.push(
        { label: "Training-only (No Guarantee) Course", value: keep(C.trainingOnlyCourse) },
        { label: "", value: "" }
      );
    }
    twoColGrid(doc, area, rows, { labelRatio: 0.48 });
  });

  /* ---------- Education ---------- */
  await sectionBox(doc, "Educational Details", async (area) => {
    drawEduTable(doc, area, (payload.education || []).map(e => ({
      qualification: keep(e.qualification, "-"),
      school:       keep(e.school, "-"),
      year:         keep(e.year, "-"),
      percentage:   keep(e.percentage, "-"),
    })));
  });

  /* ---------- IDs ---------- */
  await sectionBox(doc, "ID Details", async (area) => {
    twoColGrid(doc, area, [
      { label: "Permanent Account Number (PAN)", value: keep(ID.pan) },
      { label: "Aadhaar Card / Driving License Number", value: keep(ID.aadhaarOrDriving) },
    ], { labelRatio: 0.62 });
  });

  /* ---------- Center + Photo ---------- */
  await sectionBox(doc, "Center", async (area) => {
    const photoW = 150, photoH = 130, gap = 16;
    const leftW  = area.w - photoW - gap;

    twoColGrid(doc, { x: area.x, y: area.y, w: leftW }, [
      { label: "Place of Admission", value: keep(CTR.placeOfAdmission) },
      { label: "Mode", value: keep(CTR.mode) },
    ], { labelRatio: 0.48 });

    const rightX = area.x + leftW + gap;
    const topY   = area.y;

    // ❌ no photo border
    doc.fontSize(9).text("STUDENT PHOTO", rightX, topY - 12, { width: photoW, align: "center" });

    // ✅ prioritize photoDataUrl (passport photo for PDF)
    const photoBuf = await toImageBuffer(payload?.uploads?.photoDataUrl);

    if (photoBuf) {
      await drawCenteredImage(doc, photoBuf, rightX, topY, photoW, photoH);
    }

    doc.y = Math.max(doc.y, topY + photoH);
  });

  /* ---------- T&C (TABLE-ONLY like reference) ---------- */
  doc.addPage();

  // If you pass table via payload.tc.tableMd or payload.tc.table, we render ONLY the table
  const providedTableMd  = normalizeTableMarkdown(payload?.tc?.tableMd || "");
  const providedTableArr = Array.isArray(payload?.tc?.table) && payload.tc.table.length
    ? buildTableMarkdownFromArray(payload.tc.table)
    : "";
  const finalTableMd = normalizeTableMarkdown(providedTableMd || providedTableArr);

  if (finalTableMd) {
    // Just render the table (no heading/notice)
    renderTerms(doc, finalTableMd);
  } else {
    // fallback to old behaviour (kept intact)
    ensureSpace(doc, 30); // Ensure space for heading
    doc.font("Helvetica-Bold").fontSize(14)
      .text(
        isJobAssistance ? "Job Assistance Terms & Conditions" : (isBootcamp ? "Bootcamp Training Terms & Conditions" : (isTrainingOnly ? "Training Terms & Conditions" : "Job Guarantee Terms & Conditions")),
        { align: "center", underline: true }
      );
    doc.font("Helvetica").moveDown(0.4);
    if (isTrainingOnly) {
      noticeBox(doc, "Training-only enrollment: Fees are non-refundable. Please read the terms carefully.");
    }
    const tcTextRaw = (payload.tc?.text || "").trim();
    const tcText = tcTextRaw || (isBootcamp ? DEFAULT_BOOTCAMP_TNC : (isTrainingOnly ? DEFAULT_TRAINING_ONLY_TNC : (isJobAssistance ? DEFAULT_JOB_ASSISTANCE_TNC : DEFAULT_TNC_TERMS)));
    if (tcText) renderTerms(doc, tcText);
    else doc.text("No Terms & Conditions provided.", { align: "center" });
  }

  // Add document submission note before DATE/PLACE/MODE
  doc.moveDown(0.3);
  doc.fontSize(9).text("Note: Kindly submit 2 Passport Size Photographs, One Digital Photograph for online records, PAN Card and Aadhar/Driving License photocopy along with signed copy of this agreement.");
  
  // DATE PLACE MODE - each on separate line
  doc.moveDown(0.2);
  doc.fontSize(10).text(`DATE: ${new Date().toLocaleDateString('en-IN')}`);
  doc.fontSize(10).text(`PLACE OF ADMISSION: ${keep(CTR.placeOfAdmission, "-")}`);
  doc.fontSize(10).text(`ONLINE / OFFLINE: ${keep(CTR.mode, "-")}`);
  
  doc.moveDown(0.3);
  const gapCols = 20;
  const colW    = (CONTENT_W - 2 * gapCols) / 3;
  const colX    = [ MARGIN, MARGIN + colW + gapCols, MARGIN + 2*(colW + gapCols) ];

  // Headings - all on same line
  doc.font("Helvetica-Bold").fontSize(11)
     .text("STUDENT",              colX[0], doc.y)
     .text("PARENT/GUARDIAN",      colX[1], doc.y)
     .text("For Awdiz Sign & Seal",colX[2], doc.y);
  doc.font("Helvetica");
  doc.moveDown(0.2);

  const sigH = 50; // smaller slot
  const pad  = 3;

  const loadImg = async (...candidates) => {
    for (const c of candidates) {
      const b = await toImageBuffer(c);
      if (b) return b;
    }
    return null;
  };

  // Get current Y position for all signature boxes
  const signStartY = doc.y;

  // Student signature
  const studentSignBuf = await loadImg(
    payload?.signatures?.student?.signDataUrl,
    payload?.signatures?.student?.signUrl,
    payload?.studentSignatureUrl,
    payload?.files?.studentSignUrl
  );
  if (studentSignBuf) {
    await drawCenteredImage(doc, studentSignBuf, colX[0] + pad, signStartY + pad, colW - 10 - pad*2, sigH - pad*2);
  } else {
    doc.rect(colX[0] + pad, signStartY + pad, colW - 10 - pad*2, sigH - pad*2).stroke();
  }

  // Parent/Guardian signature
  const parentSignBuf = await loadImg(
    payload?.signatures?.parent?.signDataUrl,
    payload?.signatures?.parent?.signUrl,
    payload?.parentSignatureUrl,
    payload?.guardianSignatureUrl,
    payload?.files?.parentSign,
    payload?.files?.guardianSign,
    payload?.files?.parentSignUrl,
    payload?.files?.guardianSignUrl
  );

  if (parentSignBuf) {
    await drawCenteredImage(
      doc,
      parentSignBuf,
      colX[1] + pad,
      signStartY + pad,
      colW - 10 - pad * 2,
      sigH - pad * 2
    );
  } else {
    doc.rect(colX[1] + pad, signStartY + pad, colW - 10 - pad * 2, sigH - pad * 2).stroke();
  }

  // Right column: Awdiz sign (top) + seal (bottom)
  const awdizSignBuf = await loadImg(
    payload?.brand?.awdizSignUrl,
    process.env.AWDIZ_SIGN_URL
  );
  const awdizSealBuf = await loadImg(
    payload?.brand?.awdizSealUrl,
    process.env.AWDIZ_SEAL_URL
  );

  const rightInnerX = colX[2] + pad;
  const rightInnerW = colW - 10 - pad*2;
  const rightInnerH = sigH - pad*2;
  const miniGap = 8;
  const slotH = Math.floor((rightInnerH - miniGap) / 2);

  if (awdizSignBuf) {
    await drawCenteredImage(doc, awdizSignBuf, rightInnerX, signStartY + pad, rightInnerW, slotH);
  }
  if (awdizSealBuf) {
    await drawCenteredImage(doc, awdizSealBuf, rightInnerX, signStartY + pad + slotH + miniGap, rightInnerW, slotH);
  }

  // Move to below signature boxes
  doc.y = signStartY + sigH + 5;

  // Names row - below signature boxes
  doc.moveDown(0.2);
  doc.fontSize(9).text("FULL NAME: " + keep(payload?.signatures?.student?.fullName), colX[0], doc.y);
  doc.fontSize(9).text("FULL NAME: " + keep(payload?.signatures?.parent?.fullName || payload?.signatures?.guardian?.fullName), colX[1], doc.y);

  // Contract note - below names
  doc.moveDown(0.3);
  doc.fontSize(8)
     .text("NOTE: This contract is valid for 12 months from the date of signing. All disputes subject to Mumbai jurisdiction.", { align: "left" })
     .text("Addresses: Vashi Plaza (Navi Mumbai) • Bandra (West) Mumbai", { align: "left" });

  doc.end();
const pdfBuffer = await done;

/* ✅ UPLOAD PDF TO CLOUDINARY */
const upload = await uploadPDFStream(pdfBuffer, {
  folder: "awdiz/admissions/pdfs",
  publicId: `admission-${Date.now()}`,
});

/* ✅ RETURN CLOUDINARY URL */
return {
  buffer: pdfBuffer,
  url: upload.secure_url,
  public_id: upload.public_id,
};
}
export async function buildAdmissionPdf(payload, opts = {}) {
  const { url } = await generateAdmissionPDF(payload, opts);
  return url;
}

// Export default terms for use in other modules
export { DEFAULT_BOOTCAMP_TNC, DEFAULT_TNC_TERMS, DEFAULT_TRAINING_ONLY_TNC, DEFAULT_JOB_ASSISTANCE_TNC };
