import { permanentRedirect } from "next/navigation";

const RegistryDetailPage = async ({ params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  permanentRedirect(`/templates/${slug}`);
};

export default RegistryDetailPage;
