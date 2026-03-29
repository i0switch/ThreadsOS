export type NoteIdentity = {
  id: number;
  key: string;
  slug: string;
};

export type StructuredNoteContent = {
  fullHtml: string;
  freeHtml: string;
  paidHtml: string;
  separator: string | null;
  bodyLength: number;
};

export type NoteContentContext = {
  jobId: number;
  title: string;
  noteBody: string;
  freePreviewMarkdown: string;
  paidContentMarkdown: string;
  salesMode: "normal" | "free_paid";
  transitionCtaText: string;
};

export type PublishPayload = {
  author_ids: number[];
  body_length: number;
  disable_comment: boolean;
  exclude_from_creator_top: boolean;
  exclude_ai_learning_reward: boolean;
  free_body: string;
  hashtags: string[];
  image_keys: string[];
  index: boolean;
  is_refund: boolean;
  limited: boolean;
  magazine_ids: number[];
  magazine_keys: string[];
  name: string;
  pay_body: string;
  price: number;
  send_notifications_flag: boolean;
  separator: string | null;
  slug: string;
  status: "published";
  circle_permissions: string[];
  discount_campaigns: string[];
  lead_form: {
    is_active: boolean;
    consent_url: string;
  };
  line_add_friend: {
    is_active: boolean;
    keyword: string;
    add_friend_url: string;
  };
  line_add_friend_access_token: string;
};
