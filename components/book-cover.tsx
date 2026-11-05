"use client";

import Image from "next/image";
import { useState } from "react";

type BookCoverProps = {
  src: string | null;
  title: string;
  className?: string;
  sizes?: string;
  eager?: boolean;
};

export function BookCover({
  src,
  title,
  className = "",
  sizes = "200px",
  eager = false,
}: BookCoverProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={`relative overflow-hidden rounded-sm bg-parchment ${className}`}
    >
      {src && !failed ? (
        <Image
          src={src}
          alt={`Cover of ${title}`}
          fill
          sizes={sizes}
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "auto"}
          className="object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full items-center justify-center p-4 text-center font-display text-sm leading-snug text-ink/55">
          {title}
        </div>
      )}
    </div>
  );
}
