export function ArrowIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}
export function ChevronIcon({ direction }: { direction: "down" | "right" }) {
  return (
    <svg className="ui-icon channel-category-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d={direction === "down" ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} />
    </svg>
  );
}
export function ChatIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h14v9H9l-4 4z" />
    </svg>
  );
}
export function EmojiIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14a4.5 4.5 0 0 0 8 0" />
      <path d="M9 9h.01M15 9h.01" />
    </svg>
  );
}
export function MenuIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h14" />
    </svg>
  );
}
export function UsersIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" />
      <circle cx="12" cy="9" r="3" />
    </svg>
  );
}
export function ShieldIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4 19 7v5c0 4-2.7 6.7-7 8-4.3-1.3-7-4-7-8V7z" />
      <path d="M9 12h6" />
    </svg>
  );
}
export function UserPlusIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" />
      <circle cx="10" cy="9" r="3" />
      <path d="M18 9v6" />
      <path d="M15 12h6" />
    </svg>
  );
}
export function LinkIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14a4 4 0 0 0 6 .5l2-2a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-6-.5l-2 2A4 4 0 0 0 11.7 17l1-1" />
    </svg>
  );
}
export function PlusIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}
export function CopyIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h10v10H8z" />
      <path d="M6 14H5a1 1 0 0 1-1-1V5h8a1 1 0 0 1 1 1v1" />
    </svg>
  );
}
export function GearIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.5 1Z" />
    </svg>
  );
}
export function RefreshIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}
export function CloseIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </svg>
  );
}
export function EditIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 16-1 4 4-1L19 8l-3-3Z" />
      <path d="m14 7 3 3" />
    </svg>
  );
}
export function TrashIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6M14 10v6" />
    </svg>
  );
}
export function LeaveIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="currentColor" stroke="none">
        <path d="M12.9999 2C10.2385 2 7.99991 4.23858 7.99991 7C7.99991 7.55228 8.44762 8 8.99991 8C9.55219 8 9.99991 7.55228 9.99991 7C9.99991 5.34315 11.3431 4 12.9999 4H16.9999C18.6568 4 19.9999 5.34315 19.9999 7V17C19.9999 18.6569 18.6568 20 16.9999 20H12.9999C11.3431 20 9.99991 18.6569 9.99991 17C9.99991 16.4477 9.55219 16 8.99991 16C8.44762 16 7.99991 16.4477 7.99991 17C7.99991 19.7614 10.2385 22 12.9999 22H16.9999C19.7613 22 21.9999 19.7614 21.9999 17V7C21.9999 4.23858 19.7613 2 16.9999 2H12.9999Z" />
        <path d="M13.9999 11C14.5522 11 14.9999 11.4477 14.9999 12C14.9999 12.5523 14.5522 13 13.9999 13V11Z" />
        <path d="M5.71783 11C5.80685 10.8902 5.89214 10.7837 5.97282 10.682C6.21831 10.3723 6.42615 10.1004 6.57291 9.90549C6.64636 9.80795 6.70468 9.72946 6.74495 9.67492L6.79152 9.61162L6.804 9.59454L6.80842 9.58848C6.80846 9.58842 6.80892 9.58778 5.99991 9L6.80842 9.58848C7.13304 9.14167 7.0345 8.51561 6.58769 8.19098C6.14091 7.86637 5.51558 7.9654 5.19094 8.41215L5.18812 8.41602L5.17788 8.43002L5.13612 8.48679C5.09918 8.53682 5.04456 8.61033 4.97516 8.7025C4.83623 8.88702 4.63874 9.14542 4.40567 9.43937C3.93443 10.0337 3.33759 10.7481 2.7928 11.2929L2.08569 12L2.7928 12.7071C3.33759 13.2519 3.93443 13.9663 4.40567 14.5606C4.63874 14.8546 4.83623 15.113 4.97516 15.2975C5.04456 15.3897 5.09918 15.4632 5.13612 15.5132L5.17788 15.57L5.18812 15.584L5.19045 15.5872C5.51509 16.0339 6.14091 16.1336 6.58769 15.809C7.0345 15.4844 7.13355 14.859 6.80892 14.4122L5.99991 15C6.80892 14.4122 6.80897 14.4123 6.80892 14.4122L6.804 14.4055L6.79152 14.3884L6.74495 14.3251C6.70468 14.2705 6.64636 14.1921 6.57291 14.0945C6.42615 13.8996 6.21831 13.6277 5.97282 13.318C5.89214 13.2163 5.80685 13.1098 5.71783 13H13.9999V11H5.71783Z" />
      </g>
    </svg>
  );
}
export function HangUpIcon() {
  return (
    <svg className="ui-icon phosphor-icon" viewBox="0 -20 256 256" aria-hidden="true">
      <path
        fill="currentColor"
        stroke="none"
        d="M231.59,90.13h0C175.44,34,80.56,34,24.41,90.13c-20,20-21.92,49.49-4.69,71.71A16,16,0,0,0,32.35,168a15.8,15.8,0,0,0,5.75-1.08l49-17.37.29-.11a16,16,0,0,0,9.75-11.73l5.9-29.52a76.52,76.52,0,0,1,49.68-.11h0l6.21,29.75a16,16,0,0,0,9.72,11.59l.29.11,49,17.39a16,16,0,0,0,18.38-5.06C253.51,139.62,251.58,110.13,231.59,90.13ZM223.67,152l-.3-.12-48.82-17.33-6.21-29.74A16,16,0,0,0,158,93a92.56,92.56,0,0,0-60.34.13,16,16,0,0,0-10.32,12l-5.9,29.51L32.63,151.86c-.1,0-.17.13-.27.17-12.33-15.91-11-36.23,3.36-50.58,25-25,58.65-37.53,92.28-37.53s67.27,12.51,92.28,37.53C234.61,115.8,236,136.12,223.67,152Z"
      />
    </svg>
  );
}
export function MaximizeIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3H3v5" />
      <path d="M16 3h5v5" />
      <path d="M21 16v5h-5" />
      <path d="M3 16v5h5" />
    </svg>
  );
}
export function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" />
      <circle cx="12" cy="12" r="2.5" />
      {off ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}
export function MoreIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  );
}
export function GripIcon() {
  return (
    <svg className="ui-icon grip-icon" viewBox="0 0 16 20" aria-hidden="true">
      <circle cx="5" cy="4" r="1.2" />
      <circle cx="11" cy="4" r="1.2" />
      <circle cx="5" cy="10" r="1.2" />
      <circle cx="11" cy="10" r="1.2" />
      <circle cx="5" cy="16" r="1.2" />
      <circle cx="11" cy="16" r="1.2" />
    </svg>
  );
}
export function VolumeIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10h4l5-4v12l-5-4H4z" />
      <path d="M16 9a4 4 0 0 1 0 6" />
      <path d="M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}
// Padded past 256 so the tall capsule matches its neighbours rather than filling the box.
export function MicIcon({ off }: { off: boolean }) {
  return (
    <svg className="ui-icon phosphor-icon" viewBox="-26 -24 308 308" aria-hidden="true">
      <path
        fill="currentColor"
        stroke="none"
        d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176ZM96,64a32,32,0,0,1,64,0v64a32,32,0,0,1-64,0Zm40,143.6V240a8,8,0,0,1-16,0V207.6A80.11,80.11,0,0,1,48,128a8,8,0,0,1,16,0,64,64,0,0,0,128,0,8,8,0,0,1,16,0A80.11,80.11,0,0,1,136,207.6Z"
      />
      {off ? <path d="M43 43l170 170" /> : null}
    </svg>
  );
}
export function HeadsetIcon({ off }: { off: boolean }) {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 14v-2a7 7 0 0 1 14 0v2" />
      <path d="M5 14h3v5H6a1 1 0 0 1-1-1z" />
      <path d="M16 14h3v4a1 1 0 0 1-1 1h-2z" />
      {off ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}
export function CameraIcon({ off }: { off: boolean }) {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4z" />
      <path d="m17 11 3-2v6l-3-2z" />
      {off ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}
export function ScreenIcon({ off }: { off: boolean }) {
  return (
    <svg className="ui-icon screen-icon" viewBox="0 0 256 256" aria-hidden="true">
      <rect x="32" y="48" width="192" height="144" rx="16" transform="translate(256 240) rotate(180)" />
      <line x1="160" y1="224" x2="96" y2="224" />
      <polyline points="104 112 128 88 152 112" />
      <line x1="128" y1="88" x2="128" y2="152" />
      {off ? <line x1="32" y1="32" x2="224" y2="224" /> : null}
    </svg>
  );
}
export function ReplyIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 8 5 12l4 4" />
      <path d="M5 12h8a6 6 0 0 1 6 6v1" />
    </svg>
  );
}
export function PlayIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}
export function PauseIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
export function SkipIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5.5 15 12 6 18.5z" fill="currentColor" stroke="none" />
      <path d="M18.5 5.5v13" />
    </svg>
  );
}
/** The Queue's head while it is sounding. Bars of unequal height so it reads as
 *  level rather than as a third play control. */
export function PlayingIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 13v6" />
      <path d="M12 6v13" />
      <path d="M18 10v9" />
    </svg>
  );
}

export function KeyboardIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15.5h10" />
    </svg>
  );
}
export function BellIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3zM10 20h4" />
    </svg>
  );
}
export function HomeIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8" />
    </svg>
  );
}
export function ExternalLinkIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 3h7v7M21 3l-11 11M10 5H5v14h14v-5" />
    </svg>
  );
}
export function DownloadIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </svg>
  );
}

export function PushPinIcon() {
  return (
    <svg className="ui-icon phosphor-icon" viewBox="0 0 256 256" aria-hidden="true">
      <path
        fill="currentColor"
        stroke="none"
        d="M235.32,81.37,174.63,20.69a16,16,0,0,0-22.63,0L98.37,74.49c-10.66-3.34-35-7.37-60.4,13.14a16,16,0,0,0-1.29,23.78L85,159.71,42.34,202.34a8,8,0,0,0,11.32,11.32L96.29,171l48.29,48.29A16,16,0,0,0,155.9,224c.38,0,.75,0,1.13,0a15.93,15.93,0,0,0,11.64-6.33c19.64-26.1,17.75-47.32,13.19-60L235.33,104A16,16,0,0,0,235.32,81.37ZM224,92.69h0l-57.27,57.46a8,8,0,0,0-1.49,9.22c9.46,18.93-1.8,38.59-9.34,48.62L48,100.08c12.08-9.74,23.64-12.31,32.48-12.31A40.13,40.13,0,0,1,96.81,91a8,8,0,0,0,9.25-1.51L163.32,32,224,92.68Z"
      />
    </svg>
  );
}
export function InfoCircleIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </svg>
  );
}
