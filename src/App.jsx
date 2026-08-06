import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Camera,
  X,
  MapPin,
  Loader2,
  Sparkles,
  RefreshCw,
  MessageCircle,
  Send,
  Lock,
  LogOut,
  History,
  CheckCircle2,
  Circle,
  ArrowLeft,
  ExternalLink,
  Trash2,
  PlayCircle,
  Video,
} from "lucide-react";
import { supabase, MEDIA_BUCKET } from "./supabaseClient";

const CATEGORIES = [
  { id: "road", label: "Damaged Road", badge: "bg-orange-100 text-orange-800" },
  { id: "light", label: "Broken Streetlight", badge: "bg-amber-100 text-amber-800" },
  { id: "trash", label: "Piled-up Trash", badge: "bg-emerald-100 text-emerald-800" },
  { id: "other", label: "Other", badge: "bg-indigo-100 text-indigo-800" },
];

const OFFICER_USERNAME = "ForOfficer@Fixly.com";
const OFFICER_PASSWORD = "EQT23W";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_VIDEO_SECONDS = 30;

function categoryInfo(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[3];
}
function pad(n) {
  return String(n).padStart(4, "0");
}
function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const datePart = d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} · ${timePart}`;
}

function compressImageToBlob(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1200;
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height >= width && height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.78);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getVideoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (duration) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(duration);
    };

    video.onloadedmetadata = () => {
      if (isFinite(video.duration) && video.duration > 0) {
        finish(video.duration);
        return;
      }
      try {
        video.currentTime = 1e10;
        video.ontimeupdate = () => {
          video.ontimeupdate = null;
          finish(isFinite(video.duration) ? video.duration : null);
        };
      } catch {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
    video.load();
    setTimeout(() => finish(null), 8000);
  });
}

async function loadMediaFile(file) {
  if (file.type.startsWith("video/")) {
    const duration = await getVideoDuration(file);
    if (duration !== null && duration > MAX_VIDEO_SECONDS) {
      throw new Error(`Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter (this one is ${Math.round(duration)}s).`);
    }
    const mayNotPreview = file.type === "video/quicktime" || /\.mov$/i.test(file.name || "");
    return { type: "video", blob: file, ext: (file.name?.split(".").pop() || "mp4"), mayNotPreview };
  }
  const blob = await compressImageToBlob(file);
  return { type: "image", blob, ext: "jpg" };
}

async function uploadMedia(media, folder) {
  const filename = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${media.ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(filename, media.blob, {
    contentType: media.blob.type || (media.type === "video" ? "video/mp4" : "image/jpeg"),
  });
  if (error) throw error;
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(filename);
  return { url: data.publicUrl, type: media.type };
}

function bucketOf(report) {
  if (report.status !== "resolved") return "unfinished";
  const age = Date.now() - new Date(report.resolved_at).getTime();
  return age < DAY_MS ? "finished" : "history";
}

export default function FixlyApp() {
  const [view, setView] = useState(() => {
    const h = window.location.hash;
    if (h.includes("officer") || h.includes("admin")) return "officers";
    if (h.includes("citizen")) return "citizens";
    return "report";
  });
  const [reports, setReports] = useState(null);
  const [loadingBoard, setLoadingBoard] = useState(false);

  const [reporterName, setReporterName] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedMedia, setSelectedMedia] = useState(null);
  const [mediaPreview, setMediaPreview] = useState(null);
  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [lastTicket, setLastTicket] = useState(null);
  const photoInputRef = useRef(null);
  const videoInputRef = useRef(null);

  const [officerAuthed, setOfficerAuthed] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [confirmingClearAll, setConfirmingClearAll] = useState(false);

  const fetchReports = useCallback(async () => {
    const { data, error } = await supabase.from("reports").select("*").order("created_at", { ascending: false });
    if (error) {
      console.error(error);
      return [];
    }
    return data || [];
  }, []);

  const loadReports = useCallback(
    async (showSpinner) => {
      if (showSpinner) setLoadingBoard(true);
      const data = await fetchReports();
      setReports(data);
      setLoadingBoard(false);
      return data;
    },
    [fetchReports]
  );

  useEffect(() => {
    if ((view === "citizens" || view === "officers") && reports === null) {
      loadReports(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    const channel = supabase
      .channel("reports-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "reports" }, () => {
        loadReports(false);
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [loadReports]);

  const handlePhotoInput = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    try {
      const media = await loadMediaFile(file);
      setSelectedMedia(media);
      setMediaPreview(URL.createObjectURL(media.blob));
      setFormError("");
    } catch (err) {
      setSelectedMedia(null);
      setMediaPreview(null);
      setFormError(err.message || "Could not load that file — please try again.");
      if (photoInputRef.current) photoInputRef.current.value = "";
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }

    if (navigator.geolocation) {
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
          setLocating(false);
        },
        () => {
          setCoords(null);
          setLocating(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    }
  };

  const removePhoto = (e) => {
    e.stopPropagation();
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    setSelectedMedia(null);
    setMediaPreview(null);
    setCoords(null);
    if (photoInputRef.current) photoInputRef.current.value = "";
    if (videoInputRef.current) videoInputRef.current.value = "";
  };

  const submitReport = async () => {
    if (!reporterName.trim()) return setFormError("Add your name before submitting.");
    if (!selectedMedia) return setFormError("Add a photo or video of the issue before submitting.");
    if (!selectedCategory) return setFormError("Choose a category.");
    if (!description.trim()) return setFormError("Add a short description.");
    if (!location.trim()) return setFormError("Add the location before submitting.");
    setFormError("");
    setSubmitting(true);
    try {
      const current = await fetchReports();
      const nextNum = current.length ? Math.max(...current.map((r) => r.num)) + 1 : 1;
      const uploaded = await uploadMedia(selectedMedia, "reports");

      const newReport = {
        id: "r" + Date.now() + Math.random().toString(36).slice(2, 7),
        num: nextNum,
        reporter_name: reporterName.trim(),
        category: selectedCategory,
        description: description.trim(),
        location: location.trim(),
        coords: coords,
        photo_url: uploaded.url,
        photo_type: uploaded.type,
        status: "open",
        comments: [],
      };

      const { data, error } = await supabase.from("reports").insert(newReport).select().single();
      if (error) throw error;

      setLastTicket(data);
      setReporterName("");
      setSelectedCategory(null);
      if (mediaPreview) URL.revokeObjectURL(mediaPreview);
      setSelectedMedia(null);
      setMediaPreview(null);
      setCoords(null);
      setDescription("");
      setLocation("");
      if (photoInputRef.current) photoInputRef.current.value = "";
      if (videoInputRef.current) videoInputRef.current.value = "";
      loadReports(false);
    } catch (e) {
      console.error(e);
      setFormError("Could not submit — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const addComment = async (reportId, text) => {
    const current = reports.find((r) => r.id === reportId);
    if (!current) return;
    const updatedComments = [
      ...(current.comments || []),
      { id: "c" + Date.now() + Math.random().toString(36).slice(2, 5), text, createdAt: new Date().toISOString() },
    ];
    const { error } = await supabase.from("reports").update({ comments: updatedComments }).eq("id", reportId);
    if (!error) loadReports(false);
  };

  const toggleStatus = async (reportId, proofMedia, dutyOfficer) => {
    const current = reports.find((r) => r.id === reportId);
    if (!current) return;
    const nowResolved = current.status !== "resolved";
    let update = {
      status: nowResolved ? "resolved" : "open",
      resolved_at: nowResolved ? new Date().toISOString() : null,
    };
    if (nowResolved && proofMedia) {
      const uploaded = await uploadMedia(proofMedia, "proof");
      update.proof_url = uploaded.url;
      update.proof_type = uploaded.type;
      update.duty_officer = dutyOfficer || null;
    } else if (!nowResolved) {
      update.proof_url = null;
      update.proof_type = null;
      update.duty_officer = null;
    }
    const { error } = await supabase.from("reports").update(update).eq("id", reportId);
    if (!error) loadReports(false);
  };

  const deleteReport = async (reportId) => {
    const { error } = await supabase.from("reports").delete().eq("id", reportId);
    if (!error) loadReports(false);
  };

  const clearAll = async () => {
    const { error } = await supabase.from("reports").delete().neq("id", "");
    if (!error) {
      setConfirmingClearAll(false);
      loadReports(false);
    }
  };

  const switchView = (v) => {
    setView(v);
    setLastTicket(null);
    window.location.hash = v === "officers" ? "officers" : v === "citizens" ? "citizens" : "report";
  };

  const checkLogin = () => {
    if (usernameInput.trim() === OFFICER_USERNAME && passwordInput === OFFICER_PASSWORD) {
      setOfficerAuthed(true);
      setLoginError("");
    } else {
      setLoginError("Incorrect username or password. Check with your supervisor and try again.");
    }
  };

  const list = reports || [];
  const buckets = useMemo(() => {
    const b = { unfinished: [], finished: [], history: [] };
    list.forEach((r) => b[bucketOf(r)].push(r));
    return b;
  }, [list]);

  return (
    <div className="min-h-screen bg-stone-200 flex justify-center">
      <div className="w-full max-w-xl bg-stone-50 min-h-screen shadow-xl flex flex-col">
        <header className="bg-stone-900 text-stone-50 px-5 pt-6 sticky top-0 z-20">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h1 className="font-bold text-xl uppercase tracking-wide">
                Fix<span className="text-amber-400">ly</span>
              </h1>
              <p className="font-mono text-[10px] text-stone-400 tracking-wide mt-0.5">
                {view === "officers" ? "OFFICER ACCESS" : view === "citizens" ? "CITIZEN REPORTS" : "CITIZEN REPORTING"}
              </p>
            </div>
            {(view === "citizens" || (view === "officers" && officerAuthed)) && (
              <button onClick={() => loadReports(true)} aria-label="Refresh" className="text-stone-300 hover:text-amber-400 mt-1">
                <RefreshCw size={17} className={loadingBoard ? "animate-spin" : ""} />
              </button>
            )}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => switchView("report")}
              className={`flex-1 py-3 px-1 text-[11px] sm:text-xs font-semibold uppercase tracking-wide border-b-2 transition-colors ${
                view === "report" ? "text-amber-400 border-amber-400" : "text-stone-400 border-transparent hover:text-stone-100"
              }`}
            >
              Report an Issue
            </button>
            <button
              onClick={() => switchView("citizens")}
              className={`flex-1 py-3 px-1 text-[11px] sm:text-xs font-semibold uppercase tracking-wide border-b-2 transition-colors ${
                view === "citizens" ? "text-amber-400 border-amber-400" : "text-stone-400 border-transparent hover:text-stone-100"
              }`}
            >
              For Citizens
            </button>
            <button
              onClick={() => switchView("officers")}
              className={`flex-1 py-3 px-1 text-[11px] sm:text-xs font-semibold uppercase tracking-wide border-b-2 transition-colors ${
                view === "officers" ? "text-amber-400 border-amber-400" : "text-stone-400 border-transparent hover:text-stone-100"
              }`}
            >
              For Officers
            </button>
          </div>
        </header>

        <main className="flex-1 px-5 py-5 pb-14">
          {view === "report" && (
            <ReportForm
              lastTicket={lastTicket}
              onNewReport={() => setLastTicket(null)}
              reporterName={reporterName}
              onReporterNameChange={setReporterName}
              selectedMedia={selectedMedia}
              mediaPreview={mediaPreview}
              coords={coords}
              locating={locating}
              onPhotoInput={handlePhotoInput}
              onRemovePhoto={removePhoto}
              photoInputRef={photoInputRef}
              videoInputRef={videoInputRef}
              selectedCategory={selectedCategory}
              onSelectCategory={setSelectedCategory}
              description={description}
              onDescriptionChange={setDescription}
              location={location}
              onLocationChange={setLocation}
              formError={formError}
              submitting={submitting}
              onSubmit={submitReport}
            />
          )}

          {view === "citizens" && (
            <ReportBrowser mode="citizen" loading={loadingBoard && reports === null} buckets={buckets} onAddComment={addComment} />
          )}

          {view === "officers" &&
            (!officerAuthed ? (
              <OfficerGate
                usernameInput={usernameInput}
                onUsernameChange={setUsernameInput}
                passwordInput={passwordInput}
                onPasswordChange={setPasswordInput}
                onSubmit={checkLogin}
                error={loginError}
              />
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="font-mono text-[11px] uppercase tracking-wide text-stone-500">Officer view</p>
                  <button
                    onClick={() => {
                      setOfficerAuthed(false);
                      setUsernameInput("");
                      setPasswordInput("");
                    }}
                    className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-800"
                  >
                    <LogOut size={13} /> Log out
                  </button>
                </div>
                <ReportBrowser
                  mode="officer"
                  loading={loadingBoard && reports === null}
                  buckets={buckets}
                  onToggleStatus={toggleStatus}
                  onDeleteReport={deleteReport}
                />
                {list.length > 0 && (
                  <div className="text-center mt-6">
                    {!confirmingClearAll ? (
                      <button onClick={() => setConfirmingClearAll(true)} className="text-red-600 text-xs underline">
                        Clear all reports
                      </button>
                    ) : (
                      <div className="inline-flex items-center gap-2 bg-red-50 border border-red-300 rounded-md px-3 py-2">
                        <span className="text-xs font-semibold text-red-700">Clear everything?</span>
                        <button onClick={clearAll} className="text-xs font-semibold px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700">
                          Yes, clear all
                        </button>
                        <button
                          onClick={() => setConfirmingClearAll(false)}
                          className="text-xs font-semibold px-2.5 py-1 rounded border border-stone-300 text-stone-600 hover:bg-stone-100"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
        </main>

        <footer className="text-center pb-6">
          <p className="font-semibold text-sm text-stone-700 tracking-wide mb-1.5">
            See It. Snap It. <span className="text-amber-600">Fixed.</span>
          </p>
          <p className="font-mono text-[10px] text-stone-400 tracking-wide">
            Fixly — PHOTO IN, RESOLVED OUT
            <br />
            <span className="text-stone-300">powered by Supabase</span>
          </p>
        </footer>
      </div>
    </div>
  );
}

function ReportForm({
  lastTicket,
  onNewReport,
  reporterName,
  onReporterNameChange,
  selectedMedia,
  mediaPreview,
  coords,
  locating,
  onPhotoInput,
  onRemovePhoto,
  photoInputRef,
  videoInputRef,
  selectedCategory,
  onSelectCategory,
  description,
  onDescriptionChange,
  location,
  onLocationChange,
  formError,
  submitting,
  onSubmit,
}) {
  if (lastTicket) {
    return (
      <div className="border border-dashed border-stone-300 rounded bg-stone-50 text-center py-10 px-4">
        <div className="inline-block border-2 border-emerald-700 text-emerald-800 font-bold text-sm uppercase tracking-widest px-4 py-2 rounded -rotate-6 mb-4">
          Filed
        </div>
        <div className="font-mono text-2xl font-semibold text-stone-800 mb-1">#{pad(lastTicket.num)}</div>
        <p className="text-sm text-stone-500 mb-5">Track this report and add comments any time from the "For Citizens" tab.</p>
        <button onClick={onNewReport} className="border border-stone-800 text-stone-800 text-sm font-semibold px-4 py-2 rounded hover:bg-stone-100">
          File another report
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-stone-500 mb-1">Step 1 of 1</p>
      <h2 className="font-semibold text-xl text-stone-800 mb-4">Report an issue</h2>

      <div className="border border-dashed border-stone-300 rounded bg-stone-50 p-5">
        <div className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">Your name</label>
          <input
            type="text"
            value={reporterName}
            onChange={(e) => onReporterNameChange(e.target.value)}
            placeholder="Full name"
            className="w-full border border-stone-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>

        {selectedMedia ? (
          <div className="rounded-md relative overflow-hidden border border-stone-300">
            {selectedMedia.type === "video" ? (
              <video src={mediaPreview} controls playsInline className="w-full max-h-72 object-cover block bg-black" />
            ) : (
              <img src={mediaPreview} alt="Selected issue" className="w-full max-h-72 object-cover block" />
            )}
            <button
              type="button"
              onClick={onRemovePhoto}
              aria-label="Remove media"
              className="absolute top-2 right-2 bg-stone-900/75 text-white w-7 h-7 rounded-full flex items-center justify-center"
            >
              <X size={15} />
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-stone-300 bg-stone-200 rounded-md py-7 px-3 text-center cursor-pointer hover:border-amber-500">
              <Camera className="text-stone-500" size={26} strokeWidth={1.6} />
              <span className="font-semibold text-sm text-stone-800">Take Photo</span>
              <span className="text-[11px] text-stone-500">Opens camera</span>
              <input ref={photoInputRef} type="file" accept="image/*" capture="environment" onChange={onPhotoInput} className="hidden" />
            </label>
            <label className="flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-stone-300 bg-stone-200 rounded-md py-7 px-3 text-center cursor-pointer hover:border-amber-500">
              <Video className="text-stone-500" size={26} strokeWidth={1.6} />
              <span className="font-semibold text-sm text-stone-800">Record Video</span>
              <span className="text-[11px] text-stone-500">Max {MAX_VIDEO_SECONDS}s</span>
              <input ref={videoInputRef} type="file" accept="video/*" capture="environment" onChange={onPhotoInput} className="hidden" />
            </label>
          </div>
        )}

        {selectedMedia && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-stone-500">
            <MapPin size={12} />
            {locating ? (
              <span className="flex items-center gap-1">
                <Loader2 className="animate-spin" size={11} /> Getting device location…
              </span>
            ) : coords ? (
              <span>
                Coordinates captured: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
              </span>
            ) : (
              <span>Location unavailable — coordinates weren't captured for this {selectedMedia.type}.</span>
            )}
          </div>
        )}

        {selectedMedia?.mayNotPreview && (
          <div className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
            This video format may not preview in every browser, but it will still be saved and submitted normally.
          </div>
        )}

        <div className="mt-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">Category</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelectCategory(c.id)}
                className={`border rounded-full px-3.5 py-2 text-sm font-medium transition-colors ${
                  selectedCategory === c.id
                    ? "bg-stone-900 border-stone-900 text-amber-400"
                    : "bg-stone-50 border-stone-300 text-stone-800 hover:border-stone-400"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">What's going on?</label>
          <textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="e.g. Large pothole blocking the right lane near the corner store"
            className="w-full border border-stone-300 rounded-md px-3 py-2.5 text-sm min-h-[80px] focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>

        <div className="mt-5">
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">Location</label>
          <div className="relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" size={15} />
            <input
              type="text"
              value={location}
              onChange={(e) => onLocationChange(e.target.value)}
              placeholder="Street name, cross street, or landmark"
              className="w-full border border-stone-300 rounded-md pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {formError && <div className="mt-4 bg-red-50 border border-red-300 text-red-800 text-sm px-3 py-2.5 rounded-md">{formError}</div>}

        <button
          onClick={onSubmit}
          disabled={submitting}
          className="w-full mt-6 bg-stone-900 text-amber-400 font-semibold uppercase tracking-wide text-sm py-3.5 rounded-md hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="animate-spin" size={16} />}
          {submitting ? "Submitting…" : "File Report"}
        </button>
      </div>
    </div>
  );
}

function OfficerGate({ usernameInput, onUsernameChange, passwordInput, onPasswordChange, onSubmit, error }) {
  return (
    <div className="border border-dashed border-stone-300 rounded bg-stone-50 text-center py-12 px-5">
      <Lock className="mx-auto mb-3 text-stone-500" size={26} />
      <h2 className="font-semibold text-lg text-stone-800 mb-1">Officer login</h2>
      <p className="text-sm text-stone-500 mb-5">Sign in with your officer account to edit report status.</p>

      <div className="max-w-xs mx-auto space-y-3 text-left">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500 mb-1.5">Account</label>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            value={usernameInput}
            onChange={(e) => onUsernameChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder="Account"
            className="w-full border border-stone-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-stone-500 mb-1.5">Password</label>
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => onPasswordChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder="Password"
            className="w-full border border-stone-300 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
        </div>
      </div>

      {error && <div className="text-red-600 text-xs mt-3">{error}</div>}
      <button
        onClick={onSubmit}
        className="mt-5 bg-stone-900 text-amber-400 font-semibold uppercase tracking-wide text-sm px-6 py-2.5 rounded-md hover:bg-stone-800"
      >
        Log In
      </button>
    </div>
  );
}

function ReportBrowser({ mode, loading, buckets, onAddComment, onToggleStatus, onDeleteReport }) {
  const [filter, setFilter] = useState("unfinished");
  const [viewingHistory, setViewingHistory] = useState(false);

  if (loading) {
    return (
      <div className="text-center py-14 text-stone-500 text-sm flex items-center justify-center gap-2">
        <Loader2 className="animate-spin" size={16} /> Loading reports…
      </div>
    );
  }

  const total = buckets.unfinished.length + buckets.finished.length + buckets.history.length;

  if (viewingHistory) {
    const historyList = buckets.history;
    return (
      <div>
        <button onClick={() => setViewingHistory(false)} className="flex items-center gap-1.5 text-sm font-semibold text-stone-600 hover:text-stone-900 mb-4">
          <ArrowLeft size={15} /> Back
        </button>
        <div className="flex items-center gap-2 mb-1">
          <History size={17} className="text-stone-500" />
          <h2 className="font-semibold text-xl text-stone-800">History</h2>
        </div>
        <p className="text-[11px] text-stone-500 mb-4">Reports finished more than 24 hours ago. Kept here permanently.</p>
        {historyList.length === 0 ? (
          <div className="text-center py-14 text-stone-500">
            <div className="font-semibold text-base text-stone-800 mb-1">No history yet</div>
            <div className="text-sm">Reports appear here 24 hours after being marked finished.</div>
          </div>
        ) : (
          <div className="space-y-3">
            {historyList.map((r) => (
              <ReportCard key={r.id} report={r} mode={mode} onAddComment={onAddComment} onToggleStatus={onToggleStatus} onDeleteReport={onDeleteReport} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const filtered = buckets[filter] || [];

  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-wide text-stone-500 mb-1">{mode === "officer" ? "Administrator tools" : "Community view"}</p>
      <h2 className="font-semibold text-xl text-stone-800 mb-1">{mode === "officer" ? "Edit report status" : "Browse reports"}</h2>
      <p className="text-[11px] text-stone-500 mb-4">
        {mode === "officer" ? "Mark Finished requires a photo or video proving the work is done." : "Finished reports move to History 24 hours after resolution."}
      </p>

      <div className="flex items-center justify-between border-b border-stone-300 mb-4">
        <div className="flex gap-1">
          {[
            ["unfinished", "Unfinished", buckets.unfinished.length],
            ["finished", "Finished", buckets.finished.length],
          ].map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-2.5 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1 ${
                filter === key ? "text-stone-800 border-amber-500" : "text-stone-500 border-transparent"
              }`}
            >
              {label}
              <span className="font-mono text-[10px] bg-stone-200 text-stone-500 px-1.5 py-0.5 rounded-full ml-0.5">{count}</span>
            </button>
          ))}
        </div>
        <button onClick={() => setViewingHistory(true)} aria-label="View history" title="History" className="flex items-center gap-1 text-stone-500 hover:text-stone-800 mb-2.5">
          <History size={16} />
          {buckets.history.length > 0 && <span className="font-mono text-[10px] bg-stone-200 text-stone-500 px-1.5 py-0.5 rounded-full">{buckets.history.length}</span>}
        </button>
      </div>

      {total === 0 ? (
        <div className="text-center py-14 text-stone-500">
          <div className="flex justify-center mb-3 text-stone-400">
            <Sparkles size={26} />
          </div>
          <div className="font-semibold text-base text-stone-800 mb-1">The board is clear</div>
          <div className="text-sm">No reports yet. New submissions will show up here.</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-14 text-stone-500">
          <div className="font-semibold text-base text-stone-800 mb-1">Nothing here</div>
          <div className="text-sm">Try a different tab above.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <ReportCard key={r.id} report={r} mode={mode} onAddComment={onAddComment} onToggleStatus={onToggleStatus} onDeleteReport={onDeleteReport} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ report, mode, onAddComment, onToggleStatus, onDeleteReport }) {
  const cat = categoryInfo(report.category);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showProofCapture, setShowProofCapture] = useState(false);
  const [proofMedia, setProofMedia] = useState(null);
  const [proofPreview, setProofPreview] = useState(null);
  const [proofError, setProofError] = useState("");
  const [dutyOfficer, setDutyOfficer] = useState("");
  const [lightbox, setLightbox] = useState(null);
  const proofPhotoInputRef = useRef(null);
  const proofVideoInputRef = useRef(null);
  const isResolved = report.status === "resolved";
  const comments = report.comments || [];

  const postComment = async () => {
    const text = commentText.trim();
    if (!text) return;
    setPosting(true);
    try {
      await onAddComment(report.id, text);
      setCommentText("");
    } finally {
      setPosting(false);
    }
  };

  const handleReopen = async () => {
    setToggling(true);
    try {
      await onToggleStatus(report.id);
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteReport(report.id);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const handleProofInput = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (proofPreview) URL.revokeObjectURL(proofPreview);
    try {
      const media = await loadMediaFile(file);
      setProofMedia(media);
      setProofPreview(URL.createObjectURL(media.blob));
      setProofError("");
    } catch (err) {
      setProofMedia(null);
      setProofPreview(null);
      setProofError(err.message || "Could not load that file — please try again.");
      if (proofPhotoInputRef.current) proofPhotoInputRef.current.value = "";
      if (proofVideoInputRef.current) proofVideoInputRef.current.value = "";
    }
  };

  const confirmFinish = async () => {
    if (!proofMedia || !dutyOfficer.trim()) return;
    setToggling(true);
    try {
      await onToggleStatus(report.id, proofMedia, dutyOfficer.trim());
      setShowProofCapture(false);
      if (proofPreview) URL.revokeObjectURL(proofPreview);
      setProofMedia(null);
      setProofPreview(null);
      setDutyOfficer("");
    } finally {
      setToggling(false);
    }
  };

  const cancelProofCapture = () => {
    setShowProofCapture(false);
    if (proofPreview) URL.revokeObjectURL(proofPreview);
    setProofMedia(null);
    setProofPreview(null);
    setProofError("");
    setDutyOfficer("");
    if (proofPhotoInputRef.current) proofPhotoInputRef.current.value = "";
    if (proofVideoInputRef.current) proofVideoInputRef.current.value = "";
  };

  return (
    <div className="bg-stone-50 border border-stone-300 rounded-lg p-3">
      <div className="flex gap-3">
        {report.photo_type === "video" ? (
          <div
            className="w-[74px] h-[74px] rounded-md relative bg-black flex-shrink-0 cursor-zoom-in"
            onClick={() => setLightbox({ src: report.photo_url, alt: "Reported issue", type: "video" })}
          >
            <video src={report.photo_url} muted playsInline className="w-full h-full object-cover rounded-md" />
            <PlayCircle className="absolute inset-0 m-auto text-white/90 pointer-events-none" size={22} />
          </div>
        ) : (
          <img
            src={report.photo_url}
            alt="Reported issue"
            onClick={() => setLightbox({ src: report.photo_url, alt: "Reported issue", type: "image" })}
            className="w-[74px] h-[74px] rounded-md object-cover flex-shrink-0 cursor-zoom-in"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start gap-2">
            <div>
              <div className="font-mono text-[11px] text-stone-500">#{pad(report.num)}</div>
              <span className={`inline-block text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full mt-1 ${cat.badge}`}>{cat.label}</span>
            </div>
            <div
              className={`font-bold text-[10.5px] uppercase tracking-wide px-2.5 py-1 rounded border-2 -rotate-3 whitespace-nowrap ${
                isResolved ? "border-emerald-700 text-emerald-800 bg-emerald-50" : "border-amber-700 text-amber-700"
              }`}
            >
              {isResolved ? "Finished" : "Unfinished"}
            </div>
          </div>
          <p className="text-sm text-stone-800 mt-2 mb-1 leading-snug">
            {report.description}
            {report.location && <strong className="font-semibold"> — {report.location}</strong>}
          </p>
          {report.reporter_name && <div className="text-[11px] text-stone-500 mb-1">Reported by {report.reporter_name}</div>}
          {report.coords && (
            <a
              href={`https://www.google.com/maps?q=${report.coords.lat},${report.coords.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-[11px] text-amber-700 hover:underline mb-1 w-fit"
            >
              <MapPin size={11} />
              {report.coords.lat.toFixed(5)}, {report.coords.lng.toFixed(5)}
              <ExternalLink size={10} />
            </a>
          )}
          <div className="font-mono text-[11px] text-stone-500">
            {timeAgo(report.created_at)} · Reported {formatDateTime(report.created_at)}
          </div>

          {mode === "officer" && (
            <div className="flex flex-wrap gap-2 mt-2.5">
              {!isResolved && !showProofCapture && (
                <button
                  onClick={() => setShowProofCapture(true)}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-stone-900 text-amber-400 hover:bg-stone-800"
                >
                  <CheckCircle2 size={12} />
                  Mark Finished
                </button>
              )}
              {isResolved && (
                <button
                  onClick={handleReopen}
                  disabled={toggling}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md border border-stone-400 text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                >
                  {toggling ? <Loader2 className="animate-spin" size={12} /> : <Circle size={12} />}
                  Reopen as Unfinished
                </button>
              )}
              {!confirmingDelete ? (
                <button onClick={() => setConfirmingDelete(true)} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md border border-red-300 text-red-600 hover:bg-red-50">
                  <Trash2 size={12} />
                  Delete
                </button>
              ) : (
                <div className="flex items-center gap-1.5 bg-red-50 border border-red-300 rounded-md px-2.5 py-1.5">
                  <span className="text-[11px] font-semibold text-red-700">Delete permanently?</span>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {deleting && <Loader2 className="animate-spin" size={11} />}
                    Yes, delete
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                    className="text-xs font-semibold px-2.5 py-1 rounded border border-stone-300 text-stone-600 hover:bg-stone-100"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {mode === "officer" && showProofCapture && (
        <div className="mt-3 pt-3 border-t border-stone-200">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-stone-600 mb-2">
            <Camera size={13} />
            Proof of completion — required to mark finished
          </div>
          {proofMedia ? (
            <div className="rounded-md relative overflow-hidden border border-stone-300">
              {proofMedia.type === "video" ? (
                <video src={proofPreview} controls playsInline className="w-full max-h-56 object-cover block bg-black" />
              ) : (
                <img src={proofPreview} alt="Proof of completed repair" className="w-full max-h-56 object-cover block" />
              )}
              <button
                type="button"
                onClick={() => {
                  if (proofPreview) URL.revokeObjectURL(proofPreview);
                  setProofMedia(null);
                  setProofPreview(null);
                  if (proofPhotoInputRef.current) proofPhotoInputRef.current.value = "";
                  if (proofVideoInputRef.current) proofVideoInputRef.current.value = "";
                }}
                aria-label="Remove proof media"
                className="absolute top-2 right-2 bg-stone-900/75 text-white w-7 h-7 rounded-full flex items-center justify-center"
              >
                <X size={15} />
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-stone-300 bg-stone-100 rounded-md py-5 px-2 text-center cursor-pointer hover:border-amber-500">
                <Camera className="text-stone-500" size={20} strokeWidth={1.6} />
                <span className="font-semibold text-xs text-stone-800">Take Photo</span>
                <input ref={proofPhotoInputRef} type="file" accept="image/*" capture="environment" onChange={handleProofInput} className="hidden" />
              </label>
              <label className="flex flex-col items-center justify-center gap-1 border-2 border-dashed border-stone-300 bg-stone-100 rounded-md py-5 px-2 text-center cursor-pointer hover:border-amber-500">
                <Video className="text-stone-500" size={20} strokeWidth={1.6} />
                <span className="font-semibold text-xs text-stone-800">Record Video</span>
                <span className="text-[10px] text-stone-500">Max {MAX_VIDEO_SECONDS}s</span>
                <input ref={proofVideoInputRef} type="file" accept="video/*" capture="environment" onChange={handleProofInput} className="hidden" />
              </label>
            </div>
          )}

          {proofError && <p className="text-[11px] text-red-600 mt-1.5">{proofError}</p>}

          <div className="mt-2.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-stone-500 mb-1.5">Officer on duty</label>
            <input
              type="text"
              value={dutyOfficer}
              onChange={(e) => setDutyOfficer(e.target.value)}
              placeholder="Name of officer who completed the work"
              className="w-full border border-stone-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div className="flex gap-2 mt-2.5">
            <button
              onClick={confirmFinish}
              disabled={!proofMedia || !dutyOfficer.trim() || toggling}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-stone-900 text-amber-400 hover:bg-stone-800 disabled:opacity-40"
            >
              {toggling && <Loader2 className="animate-spin" size={12} />}
              Confirm & Mark Finished
            </button>
            <button onClick={cancelProofCapture} className="text-xs font-semibold px-3 py-1.5 rounded-md border border-stone-300 text-stone-600 hover:bg-stone-100">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isResolved && report.proof_url && (
        <div className="mt-3 pt-3 border-t border-stone-200">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-500 mb-1.5">Proof of completion</p>
          {report.proof_type === "video" ? (
            <video
              src={report.proof_url}
              controls
              playsInline
              onClick={() => setLightbox({ src: report.proof_url, alt: "Proof of completed repair", type: "video" })}
              className="w-full max-h-56 object-cover rounded-md bg-black cursor-zoom-in"
            />
          ) : (
            <img
              src={report.proof_url}
              alt="Proof of completed repair"
              onClick={() => setLightbox({ src: report.proof_url, alt: "Proof of completed repair", type: "image" })}
              className="w-full max-h-56 object-cover rounded-md cursor-zoom-in"
            />
          )}
          {report.duty_officer && <p className="text-[11px] text-stone-500 mt-1.5">Finalized by {report.duty_officer}</p>}
          {report.resolved_at && <p className="font-mono text-[11px] text-stone-500 mt-0.5">Finished {formatDateTime(report.resolved_at)}</p>}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-stone-200">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-stone-600 mb-2">
          <MessageCircle size={13} />
          Comments {comments.length > 0 && `(${comments.length})`}
        </div>
        {comments.length > 0 && (
          <div className="space-y-2 mb-2">
            {comments.map((c) => (
              <div key={c.id} className="bg-stone-100 rounded-md px-3 py-2">
                <p className="text-sm text-stone-800">{c.text}</p>
                <p className="font-mono text-[10px] text-stone-400 mt-1">{timeAgo(c.createdAt)}</p>
              </div>
            ))}
          </div>
        )}
        {mode === "citizen" && (
          <div className="flex gap-2">
            <input
              type="text"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && postComment()}
              placeholder="Add a comment…"
              className="flex-1 border border-stone-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
            <button
              onClick={postComment}
              disabled={posting || !commentText.trim()}
              aria-label="Post comment"
              className="bg-stone-900 text-amber-400 rounded-md px-3 disabled:opacity-40"
            >
              {posting ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
            </button>
          </div>
        )}
        {mode === "citizen" && comments.length === 0 && <p className="text-xs text-stone-400">No comments yet — be the first to add one.</p>}
      </div>

      {lightbox && <MediaLightbox src={lightbox.src} alt={lightbox.alt} type={lightbox.type} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function MediaLightbox({ src, alt, type, onClose }) {
  const [zoomed, setZoomed] = useState(false);
  const [errored, setErrored] = useState(false);
  const isVideo = type === "video";

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose} role="dialog" aria-modal="true">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close"
        className="absolute top-4 right-4 z-10 text-white bg-white/10 hover:bg-white/20 rounded-full w-9 h-9 flex items-center justify-center"
      >
        <X size={18} />
      </button>
      <div className="flex-1 overflow-auto flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {isVideo ? (
          errored ? (
            <div className="text-center text-white/80 flex flex-col items-center gap-2">
              <Video size={24} />
              <p className="text-sm">This browser can't preview this video format.</p>
              <a href={src} download className="text-amber-300 underline text-sm">
                Download to view
              </a>
            </div>
          ) : (
            <video src={src} controls autoPlay playsInline onError={() => setErrored(true)} style={{ maxWidth: "100%", maxHeight: "80vh" }} />
          )
        ) : (
          <img
            src={src}
            alt={alt}
            onClick={() => setZoomed((z) => !z)}
            style={
              zoomed
                ? { width: "220%", maxWidth: "none", cursor: "zoom-out" }
                : { maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", cursor: "zoom-in" }
            }
          />
        )}
      </div>
      <p className="text-center text-white/50 text-xs pb-5">{isVideo ? "Tap outside to close" : "Tap photo to zoom in · Tap outside to close"}</p>
    </div>
  );
}
