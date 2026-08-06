import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://hmtouplvupcenddsuqrn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6oR8v3-qJLVVwqQy5LkEtw_0RqfzBTA";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const MEDIA_BUCKET = "media";
