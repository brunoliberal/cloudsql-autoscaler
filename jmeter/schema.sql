CREATE TABLE Singers (
  SingerId   CHAR(36) NOT NULL,
  FirstName  VARCHAR(1024),
  LastName   VARCHAR(1024),
  SingerInfo BLOB,
  PRIMARY KEY (SingerId)
);

CREATE TABLE Albums (
  AlbumId    CHAR(36) NOT NULL,
  SingerId   CHAR(36) NOT NULL,
  AlbumTitle TEXT,
  PRIMARY KEY (AlbumId),
  FOREIGN KEY (SingerId) REFERENCES Singers(SingerId) ON DELETE CASCADE
);

CREATE TABLE Songs (
  TrackId    CHAR(36) NOT NULL,
  AlbumId    CHAR(36) NOT NULL,
  SingerId   CHAR(36) NOT NULL,
  SongName   TEXT,
  PRIMARY KEY (TrackId),
  FOREIGN KEY (AlbumId) REFERENCES Albums(AlbumId) ON DELETE CASCADE,
  FOREIGN KEY (SingerId) REFERENCES Singers(SingerId) ON DELETE CASCADE
);